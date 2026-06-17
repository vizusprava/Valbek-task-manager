import { useState } from 'react'
import { Bookmark, X, Plus, GripVertical, MessageSquarePlus, RefreshCw, Pencil, Play, Maximize2, ChevronLeft, ChevronRight } from 'lucide-react'
import type { SavedView, ViewerAnnotation } from './adapter'

/** Panel uložených pohledů + prezentační ovládání. Stav přejmenování/dragu/rozbalení drží lokálně. */
export function ViewsPanel({
  open, onClose, canEdit, views, annotations, presIndex,
  onSaveView, onRenameView, onDeleteView, onUpdateViewCamera, onReorder, onGoToView, onToggleViewAnnotation,
  onStartPresentation, onStep, onEndPresentation,
}: {
  open: boolean
  onClose: () => void
  canEdit: boolean
  views: SavedView[]
  annotations: ViewerAnnotation[]
  presIndex: number | null
  onSaveView: (name: string) => void
  onRenameView: (id: string, name: string) => void
  onDeleteView: (id: string) => void
  onUpdateViewCamera: (v: SavedView) => void
  onReorder: (orderedIds: string[]) => void
  onGoToView: (v: SavedView) => void
  onToggleViewAnnotation: (v: SavedView, annId: string) => void
  onStartPresentation: () => void
  onStep: (dir: 1 | -1) => void
  onEndPresentation: () => void
}) {
  const [newViewName, setNewViewName] = useState('')
  const [renamingId, setRenamingId]   = useState<string | null>(null)
  const [nameDraft, setNameDraft]     = useState('')
  const [dragId, setDragId]           = useState<string | null>(null)
  const [dragOverId, setDragOverId]   = useState<string | null>(null)
  const [expandedId, setExpandedId]   = useState<string | null>(null)

  function startRename(v: SavedView) { setRenamingId(v.id); setNameDraft(v.name) }
  function commitRename(v: SavedView) {
    const n = nameDraft.trim()
    setRenamingId(null)
    if (n && n !== v.name) onRenameView(v.id, n)
  }
  function save() { onSaveView(newViewName.trim()); setNewViewName('') }
  function drop(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(null); setDragOverId(null); return }
    const ids = views.map(v => v.id)
    const from = ids.indexOf(dragId), to = ids.indexOf(targetId)
    setDragId(null); setDragOverId(null)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    onReorder(ids)
  }

  return (
    <>
      {open && (
        <div className="absolute top-3 left-3 z-10 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl shadow-2xl w-60 max-w-[calc(100vw-1.5rem)] overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5"><Bookmark size={12} /> Pohledy</span>
            <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors"><X size={12} /></button>
          </div>
          <div className="p-3 space-y-3">
            {canEdit && (
              <div className="flex gap-1.5">
                <input
                  value={newViewName}
                  onChange={e => setNewViewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') save() }}
                  placeholder={`Pohled ${views.length + 1}`}
                  className="flex-1 min-w-0 px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded-md text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button onClick={save} title="Uložit aktuální pohled"
                  className="px-2 py-1 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors shrink-0">
                  <Plus size={13} />
                </button>
              </div>
            )}
            {views.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-2">Zatím žádné pohledy</p>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1">
                {views.map((v, i) => {
                  const annCount = v.annotationIds?.length ?? 0
                  const expanded = expandedId === v.id
                  return (
                    <div key={v.id}>
                      <div
                        draggable={canEdit && renamingId !== v.id}
                        onDragStart={() => setDragId(v.id)}
                        onDragEnd={() => { setDragId(null); setDragOverId(null) }}
                        onDragOver={e => { if (dragId && dragId !== v.id) { e.preventDefault(); setDragOverId(v.id) } }}
                        onDrop={e => { e.preventDefault(); drop(v.id) }}
                        className={`flex items-center gap-1 rounded px-1.5 py-1.5 cursor-pointer group transition-colors ${
                          dragOverId === v.id ? 'bg-indigo-900/60 ring-1 ring-indigo-500' : 'bg-gray-800 hover:bg-gray-700'
                        } ${dragId === v.id ? 'opacity-40' : ''}`}
                        onClick={() => { if (renamingId !== v.id) onGoToView(v) }}
                      >
                        {canEdit && (
                          <span className="shrink-0 text-gray-600 group-hover:text-gray-400 cursor-grab active:cursor-grabbing transition-colors" title="Přetáhni pro přeřazení">
                            <GripVertical size={12} />
                          </span>
                        )}
                        <span className="text-[10px] text-gray-600 w-3.5 shrink-0 text-center">{i + 1}</span>
                        {renamingId === v.id ? (
                          <input
                            autoFocus
                            value={nameDraft}
                            onChange={e => setNameDraft(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onBlur={() => commitRename(v)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitRename(v)
                              else if (e.key === 'Escape') setRenamingId(null)
                            }}
                            className="flex-1 min-w-0 px-1 py-0.5 text-xs bg-gray-900 border border-indigo-500 rounded text-gray-100 focus:outline-none"
                          />
                        ) : (
                          <span
                            className="text-xs text-gray-300 truncate flex-1"
                            onDoubleClick={e => { if (canEdit) { e.stopPropagation(); startRename(v) } }}
                            title={canEdit ? 'Dvojklik pro přejmenování' : undefined}
                          >
                            {v.name}
                          </span>
                        )}
                        {canEdit && renamingId !== v.id && (
                          <>
                            <button
                              onClick={e => { e.stopPropagation(); setExpandedId(expanded ? null : v.id) }}
                              title="Anotace v tomto pohledu"
                              className={`flex items-center gap-0.5 shrink-0 transition-all ${expanded ? 'text-amber-400' : annCount ? 'text-amber-500/80 hover:text-amber-400' : 'text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100'}`}
                            >
                              <MessageSquarePlus size={11} />
                              {annCount > 0 && <span className="text-[9px] font-semibold">{annCount}</span>}
                            </button>
                            <button onClick={e => { e.stopPropagation(); onUpdateViewCamera(v) }}
                              className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-sky-400 shrink-0 transition-all" title="Aktualizovat na aktuální záběr kamery">
                              <RefreshCw size={11} />
                            </button>
                            <button onClick={e => { e.stopPropagation(); startRename(v) }}
                              className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-gray-300 shrink-0 transition-all" title="Přejmenovat">
                              <Pencil size={11} />
                            </button>
                            <button onClick={e => { e.stopPropagation(); onDeleteView(v.id) }}
                              className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 shrink-0 transition-all" title="Smazat">
                              <X size={11} />
                            </button>
                          </>
                        )}
                      </div>
                      {expanded && canEdit && (
                        <div className="mt-0.5 ml-2 mb-1 pl-2 border-l border-gray-700 space-y-0.5">
                          <p className="text-[10px] text-gray-500 py-1">Anotace, které v tomto pohledu naskáčou:</p>
                          {annotations.length === 0 ? (
                            <p className="text-[10px] text-gray-600 pb-1">Žádné anotace v modelu. Přidej je tlačítkem „Poznámka".</p>
                          ) : annotations.map(ann => {
                            const on = (v.annotationIds ?? []).includes(ann.id)
                            return (
                              <label key={ann.id} className="flex items-start gap-1.5 py-0.5 cursor-pointer select-none group/ann">
                                <input type="checkbox" checked={on} onChange={() => onToggleViewAnnotation(v, ann.id)}
                                  className="w-3 h-3 mt-0.5 accent-amber-500 shrink-0" />
                                <span className="text-[10px] text-gray-400 group-hover/ann:text-gray-200 line-clamp-2 leading-snug transition-colors">{ann.text}</span>
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {views.length > 1 && (
              <div className="space-y-1">
                <button
                  onClick={onStartPresentation}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
                >
                  <Play size={12} /> Spustit prezentaci
                </button>
                <p className="text-[10px] text-gray-600 flex items-center justify-center gap-1">
                  <Maximize2 size={9} /> ← → přeskočit · Esc konec · F11 fullscreen
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {presIndex !== null && views.length > 0 && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-full px-3 py-2 shadow-2xl">
          <button onClick={() => onStep(-1)} title="Předchozí (←)"
            className="text-gray-400 hover:text-white transition-colors"><ChevronLeft size={15} /></button>
          <span className="text-xs text-gray-200 font-medium px-1 max-w-44 truncate">{views[presIndex % views.length].name}</span>
          <span className="text-[10px] text-gray-500">{(presIndex % views.length) + 1}/{views.length}</span>
          <button onClick={() => onStep(1)} title="Další (→ nebo mezerník)"
            className="text-gray-400 hover:text-white transition-colors"><ChevronRight size={15} /></button>
          <div className="w-px h-4 bg-gray-700" />
          <button onClick={onEndPresentation} title="Ukončit prezentaci (Esc)"
            className="text-gray-400 hover:text-red-400 transition-colors"><X size={14} /></button>
        </div>
      )}
    </>
  )
}
