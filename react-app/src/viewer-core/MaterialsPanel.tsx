import { useState, useRef, useEffect } from 'react'
import { Palette, Plus, Trash2, X, Check, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { MaterialDef, MaterialAssignment, TextureMapType, ViewerAdapter } from './adapter'
import { MAP_LABELS, detectMapType, processTextureFile, groupMaterialFiles } from './materials'

/** Hromadný import sráží textury na 1K, ať knihovna nenabobtná. */
const IMPORT_MAX_DIM = 1024

const MAP_SLOTS: TextureMapType[] = ['albedo', 'normal', 'roughness', 'metalness', 'ao', 'emissive', 'opacity', 'height']

/** Náhled textury — cestu resolvuje přes adapter (public URL / object URL z IndexedDB). */
function TexThumb({ adapter, path, className }: { adapter: ViewerAdapter; path: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    adapter.getTextureUrl(path).then(u => { if (live) setUrl(u) }).catch(() => {})
    return () => { live = false }
  }, [adapter, path])
  if (!url) return <div className={`${className ?? ''} bg-gray-800 animate-pulse`} />
  return <img src={url} alt="" className={className} draggable={false} />
}

/** Slot mapy ve stylu UE — thumbnail, drop přímo na slot, klik = výběr souboru. */
function MapSlot({ type, path, adapter, canEdit, onFile, onRemove }: {
  type: TextureMapType
  path: string | undefined
  adapter: ViewerAdapter
  canEdit: boolean
  onFile: (file: File) => void
  onRemove: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      onClick={() => { if (canEdit) fileRef.current?.click() }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation(); setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f && canEdit) onFile(f)
      }}
      title={`${MAP_LABELS[type]} — klikni nebo sem přetáhni soubor`}
      className={`relative aspect-square rounded-md overflow-hidden group/slot transition-colors ${canEdit ? 'cursor-pointer' : ''} ${
        over ? 'border-2 border-indigo-400 bg-indigo-500/15'
        : path ? 'border border-gray-600'
        : 'border border-dashed border-gray-700 hover:border-gray-500 bg-gray-800/40'
      }`}
    >
      <input
        ref={fileRef} type="file" accept="image/*,.tif,.tiff" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }}
      />
      {path ? (
        <TexThumb adapter={adapter} path={path} className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <Plus size={12} className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-600" />
      )}
      <span className="absolute bottom-0 inset-x-0 bg-black/75 text-[8px] text-center text-gray-300 leading-tight py-0.5 truncate px-0.5">
        {MAP_LABELS[type]}
      </span>
      {path && canEdit && (
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          title="Odebrat mapu"
          className="absolute top-0.5 right-0.5 bg-black/75 rounded p-0.5 opacity-0 group-hover/slot:opacity-100 text-gray-300 hover:text-red-400 transition-all"
        >
          <X size={9} />
        </button>
      )}
    </div>
  )
}

export function MaterialsPanel({
  materials, adapter, canEdit,
  targetLabel, targetCount,
  selectedObjectLabel, assignment,
  onSaveMaterial, onDeleteMaterial, onAssign, onUpdateAssignment, onRemoveAssignment, onClose,
}: {
  materials: MaterialDef[]
  adapter: ViewerAdapter
  canEdit: boolean
  targetLabel: string | null
  targetCount: number
  selectedObjectLabel: string | null
  assignment: MaterialAssignment | null
  onSaveMaterial: (def: MaterialDef) => void
  onDeleteMaterial: (id: string) => void
  onAssign: (materialId: string) => void
  onUpdateAssignment: (patch: Partial<MaterialAssignment>) => void
  onRemoveAssignment: () => void
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<MaterialDef | null>(null)
  const [busy, setBusy] = useState(false)
  const [batchOver, setBatchOver] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftLoadedRef = useRef(false)

  function select(def: MaterialDef) {
    if (selectedId === def.id) { setSelectedId(null); setDraft(null); return }
    setSelectedId(def.id)
    draftLoadedRef.current = true
    setDraft({ ...def, maps: { ...def.maps } })
  }

  // debounce autosave editovaného materiálu
  useEffect(() => {
    if (!draft) return
    if (draftLoadedRef.current) { draftLoadedRef.current = false; return }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => onSaveMaterial(draft), 800)
    return () => clearTimeout(saveTimer.current)
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  function createMaterial() {
    const def: MaterialDef = {
      id: crypto.randomUUID(),
      name: `Materiál ${materials.length + 1}`,
      tint: '#ffffff',
      roughness: 0.9,
      metalness: 0,
      maps: {},
    }
    onSaveMaterial(def)
    setSelectedId(def.id)
    draftLoadedRef.current = true
    setDraft(def)
  }

  async function uploadAs(type: TextureMapType, file: File) {
    if (!draft) return
    setBusy(true)
    try {
      const { blob, ext } = await processTextureFile(file, type)
      const path = await adapter.uploadTexture(draft.id, type, blob, ext)
      setDraft(d => d ? { ...d, maps: { ...d.maps, [type]: path } } : d)
    } catch (e: unknown) {
      toast.error(`${file.name}: ${e instanceof Error ? e.message : 'nahrání selhalo'}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleBatchFiles(list: FileList | File[]) {
    if (!draft) return
    const unknown: string[] = []
    for (const file of Array.from(list)) {
      const type = detectMapType(file.name)
      if (!type) { unknown.push(file.name); continue }
      await uploadAs(type, file)
    }
    if (unknown.length) {
      toast.error(`Nerozpoznáno: ${unknown.join(', ')} — přetáhni je přímo na konkrétní slot mapy`)
    }
  }

  // hromadný import: plochá složka textur → seskupit do materiálů a založit
  const [importProg, setImportProg] = useState<{ done: number; total: number; name: string } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  async function handleBulkImport(list: FileList) {
    const { groups, skipped } = groupMaterialFiles(Array.from(list))
    if (!groups.length) {
      toast.error('Nerozpoznal jsem žádný materiál. Očekávám soubory typu „Nazev_1K_albedo.tif".')
      return
    }
    const existing = new Set(materials.map(m => m.name.toLowerCase()))
    const todo = groups.filter(g => !existing.has(g.name.toLowerCase()))
    const skippedExisting = groups.length - todo.length

    let ok = 0
    for (const g of todo) {
      setImportProg({ done: ok, total: todo.length, name: g.name })
      try {
        const id = crypto.randomUUID()
        const maps: Partial<Record<TextureMapType, string>> = {}
        for (const { mapType, file } of g.maps) {
          const { blob, ext } = await processTextureFile(file, mapType, IMPORT_MAX_DIM)
          maps[mapType] = await adapter.uploadTexture(id, mapType, blob, ext)
        }
        onSaveMaterial({ id, name: g.name, tint: '#ffffff', roughness: 0.9, metalness: 0, maps })
        ok++
      } catch (e: unknown) {
        toast.error(`${g.name}: ${e instanceof Error ? e.message : 'import selhal'}`)
      }
    }
    setImportProg(null)
    const parts = [`Importováno ${ok} materiálů`]
    if (skippedExisting) parts.push(`${skippedExisting} už existuje`)
    if (skipped.length)  parts.push(`${skipped.length} souborů nerozpoznáno`)
    toast.success(parts.join(', '))
  }

  const selectedDef = materials.find(m => m.id === selectedId) ?? null

  return (
    <div className="absolute top-3 left-3 z-10 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl shadow-2xl w-72 max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-9rem)] flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between shrink-0">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5"><Palette size={12} /> Materiály</span>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors"><X size={12} /></button>
      </div>

      <div className="p-3 space-y-3 overflow-y-auto">
        {/* Browser — karty materiálů */}
        <div className="grid grid-cols-3 gap-1.5">
          {materials.map(def => (
            <button
              key={def.id}
              onClick={() => select(def)}
              title={def.name}
              className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-colors ${selectedId === def.id ? 'border-indigo-500 ring-1 ring-indigo-500/40' : 'border-gray-700 hover:border-gray-500'}`}
            >
              {def.maps.albedo ? (
                <>
                  <TexThumb adapter={adapter} path={def.maps.albedo} className="absolute inset-0 w-full h-full object-cover" />
                  {def.tint.toLowerCase() !== '#ffffff' && (
                    <div className="absolute inset-0 pointer-events-none" style={{ backgroundColor: def.tint, mixBlendMode: 'multiply' }} />
                  )}
                </>
              ) : (
                <div className="absolute inset-0" style={{ backgroundColor: def.tint }} />
              )}
              <span className="absolute bottom-0 inset-x-0 bg-black/75 text-[9px] text-gray-200 truncate px-1 py-0.5 text-left">{def.name}</span>
            </button>
          ))}
          {canEdit && (
            <button
              onClick={createMaterial}
              title="Nový materiál"
              className="aspect-square rounded-lg border-2 border-dashed border-gray-700 hover:border-indigo-500/70 text-gray-600 hover:text-indigo-400 flex items-center justify-center transition-colors"
            >
              <Plus size={18} />
            </button>
          )}
        </div>
        {materials.length === 0 && !canEdit && (
          <p className="text-xs text-gray-600 text-center">Zatím žádné materiály</p>
        )}

        {/* Hromadný import textur z plochy složky */}
        {canEdit && (
          <div>
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={!!importProg}
              title="Vyber všechny soubory textur — seskupím je do materiálů podle názvu"
              className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium border border-dashed border-gray-700 hover:border-indigo-500/70 text-gray-400 hover:text-indigo-400 disabled:opacity-50 rounded-lg transition-colors"
            >
              <Upload size={12} />
              {importProg ? `Importuji… ${importProg.done}/${importProg.total}` : 'Hromadný import textur'}
            </button>
            {importProg && (
              <div className="mt-1.5 space-y-1">
                <div className="h-1 bg-gray-800 rounded overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all"
                    style={{ width: `${importProg.total ? (importProg.done / importProg.total) * 100 : 0}%` }} />
                </div>
                <p className="text-[10px] text-gray-500 truncate">{importProg.name}</p>
              </div>
            )}
            <input
              ref={importInputRef}
              type="file"
              multiple
              accept=".tif,.tiff,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={e => { if (e.target.files?.length) handleBulkImport(e.target.files); e.target.value = '' }}
            />
          </div>
        )}

        {/* Aplikace na cíl */}
        {selectedDef && canEdit && (
          <button
            onClick={() => onAssign(selectedDef.id)}
            disabled={!targetLabel}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            <Check size={13} />
            {targetLabel ? `Použít na ${targetLabel}${targetCount > 1 ? ` (${targetCount})` : ''}` : 'Vyber objekt v modelu'}
          </button>
        )}

        {/* Editor vybraného materiálu */}
        {selectedDef && draft && (
          <div
            onDragOver={e => { e.preventDefault(); setBatchOver(true) }}
            onDragLeave={() => setBatchOver(false)}
            onDrop={e => { e.preventDefault(); setBatchOver(false); if (canEdit) handleBatchFiles(e.dataTransfer.files) }}
            className={`p-2 rounded-lg border space-y-2.5 transition-colors ${batchOver ? 'border-indigo-400 bg-indigo-500/10' : 'border-gray-800 bg-gray-950/60'}`}
          >
            <div className="flex items-center gap-1.5">
              <input
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                disabled={!canEdit}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              {canEdit && (
                <button
                  onClick={() => { setSelectedId(null); setDraft(null); onDeleteMaterial(draft.id) }}
                  title="Smazat materiál"
                  className="text-gray-600 hover:text-red-400 transition-colors shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>

            {/* Sloty map */}
            <div className="grid grid-cols-4 gap-1">
              {MAP_SLOTS.map(type => (
                <MapSlot
                  key={type}
                  type={type}
                  path={draft.maps[type]}
                  adapter={adapter}
                  canEdit={canEdit}
                  onFile={f => uploadAs(type, f)}
                  onRemove={() => {
                    const maps = { ...draft.maps }
                    delete maps[type]
                    setDraft({ ...draft, maps })
                  }}
                />
              ))}
            </div>
            <p className="text-[9px] text-gray-600 leading-snug">
              {busy ? 'Zpracovávám texturu…' : 'Klikni na slot nebo na něj přetáhni soubor. Víc souborů najednou přetáhni kamkoli sem — typ poznám z názvu (_albedo, _normal…). Umí i .tif.'}
            </p>

            <div className="flex items-center gap-2">
              <label className={`shrink-0 ${canEdit ? 'cursor-pointer' : ''}`} title="Tint — násobí albedo">
                <input type="color" value={draft.tint} disabled={!canEdit} onChange={e => setDraft({ ...draft, tint: e.target.value })} className="sr-only" />
                <div className="w-6 h-6 rounded border-2 border-gray-600 hover:border-gray-400 transition-colors" style={{ backgroundColor: draft.tint }} />
              </label>
              <span className="text-[10px] text-gray-500">Tint albeda</span>
              {draft.tint !== '#ffffff' && canEdit && (
                <button onClick={() => setDraft({ ...draft, tint: '#ffffff' })} className="text-[10px] text-gray-600 hover:text-gray-300 ml-auto">reset</button>
              )}
            </div>

            {draft.maps.normal && (
              <div>
                <div className="flex justify-between mb-0.5">
                  <span className="text-[10px] text-gray-500">Síla normal mapy</span>
                  <span className="text-[10px] text-gray-400">{(draft.normalStrength ?? 1).toFixed(2)}</span>
                </div>
                <input type="range" min={0} max={3} step={0.05} value={draft.normalStrength ?? 1} disabled={!canEdit}
                  onChange={e => setDraft({ ...draft, normalStrength: Number(e.target.value) })}
                  className="w-full accent-indigo-500" />
              </div>
            )}
            {draft.maps.height && (
              <div>
                <div className="flex justify-between mb-0.5">
                  <span className="text-[10px] text-gray-500">Síla height mapy</span>
                  <span className="text-[10px] text-gray-400">{(draft.heightStrength ?? 1).toFixed(2)}</span>
                </div>
                <input type="range" min={0} max={3} step={0.05} value={draft.heightStrength ?? 1} disabled={!canEdit}
                  onChange={e => setDraft({ ...draft, heightStrength: Number(e.target.value) })}
                  className="w-full accent-indigo-500" />
              </div>
            )}
            {!draft.maps.roughness && (
              <div>
                <div className="flex justify-between mb-0.5">
                  <span className="text-[10px] text-gray-500">Roughness</span>
                  <span className="text-[10px] text-gray-400">{draft.roughness.toFixed(2)}</span>
                </div>
                <input type="range" min={0} max={1} step={0.01} value={draft.roughness} disabled={!canEdit}
                  onChange={e => setDraft({ ...draft, roughness: Number(e.target.value) })}
                  className="w-full accent-indigo-500" />
              </div>
            )}
            {!draft.maps.metalness && (
              <div>
                <div className="flex justify-between mb-0.5">
                  <span className="text-[10px] text-gray-500">Metallic</span>
                  <span className="text-[10px] text-gray-400">{draft.metalness.toFixed(2)}</span>
                </div>
                <input type="range" min={0} max={1} step={0.01} value={draft.metalness} disabled={!canEdit}
                  onChange={e => setDraft({ ...draft, metalness: Number(e.target.value) })}
                  className="w-full accent-indigo-500" />
              </div>
            )}

            <div className="pt-1 border-t border-gray-800/70">
              <div className="flex justify-between mb-0.5">
                <span className="text-[10px] text-gray-500" title="Procedurální world-space šum — rozbije opakování textury na velkých plochách">Grunge (variace)</span>
                <span className="text-[10px] text-gray-400">{((draft.grunge ?? 0) * 100).toFixed(0)} %</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} value={draft.grunge ?? 0} disabled={!canEdit}
                onChange={e => setDraft({ ...draft, grunge: Number(e.target.value) })}
                className="w-full accent-amber-600" />
              {(draft.grunge ?? 0) > 0 && (
                <div className="mt-1.5">
                  <div className="flex justify-between mb-0.5">
                    <span className="text-[10px] text-gray-500">Velikost skvrn</span>
                    <span className="text-[10px] text-gray-400">{draft.grungeScale ?? 8} m</span>
                  </div>
                  <input type="range" min={0.5} max={60} step={0.5} value={draft.grungeScale ?? 8} disabled={!canEdit}
                    onChange={e => setDraft({ ...draft, grungeScale: Number(e.target.value) })}
                    className="w-full accent-amber-600" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* UV nastavení vybraného objektu */}
        {assignment && selectedObjectLabel && (
          <div className="pt-2 border-t border-gray-800 space-y-2.5">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Texturování: <span className="text-gray-300 normal-case">{selectedObjectLabel}</span></p>
            <div>
              <div className="flex justify-between mb-0.5">
                <span className="text-[10px] text-gray-500">Velikost dlaždice</span>
                <span className="text-[10px] text-gray-400">{assignment.tileSize} m</span>
              </div>
              <input
                type="number" min={0.05} step={0.1} value={assignment.tileSize}
                onChange={e => onUpdateAssignment({ tileSize: Math.max(0.05, Number(e.target.value) || 1) })}
                className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <div className="flex justify-between mb-0.5">
                <span className="text-[10px] text-gray-500">Rotace UV</span>
                <span className="text-[10px] text-gray-400">{assignment.rotation}°</span>
              </div>
              <input type="range" min={-180} max={180} step={1} value={assignment.rotation}
                onChange={e => onUpdateAssignment({ rotation: Number(e.target.value) })}
                className="w-full accent-indigo-500" />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <span className="text-[10px] text-gray-500 block mb-0.5">Offset X</span>
                <input type="number" step={0.1} value={assignment.offsetX}
                  onChange={e => onUpdateAssignment({ offsetX: Number(e.target.value) || 0 })}
                  className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-100 focus:outline-none" />
              </div>
              <div className="flex-1">
                <span className="text-[10px] text-gray-500 block mb-0.5">Offset Y</span>
                <input type="number" step={0.1} value={assignment.offsetY}
                  onChange={e => onUpdateAssignment({ offsetY: Number(e.target.value) || 0 })}
                  className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-100 focus:outline-none" />
              </div>
            </div>
            <button
              onClick={onRemoveAssignment}
              className="w-full py-1 text-[11px] text-red-400/80 hover:text-red-300 border border-red-900/40 hover:border-red-700/60 rounded-lg transition-colors"
            >
              Odebrat materiál z objektu
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
