import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import type { Subproject } from '@/lib/types'
import { inputClass } from './shared'

let _subRowKey = 0

interface SubRow {
  key: number
  origId: string | null
  name: string
  sort_order: number
  deleted: boolean
}

export function ManageSubprojectsModal({ open, onClose, projectId, subprojects, onSaved }: {
  open: boolean; onClose: () => void
  projectId: string; subprojects: Subproject[]
  onSaved: () => void
}) {
  const [rows, setRows] = useState<SubRow[]>([])
  const [customName, setCustomName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setRows(subprojects.map((s, i) => ({
        key: _subRowKey++,
        origId: s.id,
        name: s.name,
        sort_order: s.sort_order ?? (i + 1) * 10,
        deleted: false,
      })))
      setCustomName('')
    }
  }, [open, subprojects])

  const { data: refItems = [] } = useQuery({
    queryKey: ['ref-items-3dmax'],
    queryFn: async () => {
      const { data } = await supabase.from('reference_items')
        .select('id, code, name')
        .eq('page', '3dmax')
        .eq('section', 'model_subs')
        .order('sort_order', { ascending: true })
      return (data || []) as { id: string; code: string | null; name: string }[]
    },
    enabled: open,
  })

  const { data: templates = [] } = useQuery({
    queryKey: ['subproject-templates'],
    queryFn: async () => {
      const { data } = await supabase.from('subproject_templates')
        .select('id, name').order('sort_order', { ascending: true })
      return (data || []) as { id: string; name: string }[]
    },
    enabled: open,
  })

  const activeRows = useMemo(() => rows.filter(r => !r.deleted), [rows])
  const activeNames = useMemo(() => new Set(activeRows.map(r => r.name.toLowerCase())), [activeRows])

  const availableRefs = useMemo(() => refItems.filter(r => {
    const full = (r.code ? r.code + ' ' : '') + r.name
    return !activeNames.has(full.toLowerCase())
  }), [refItems, activeNames])

  const availableTpls = useMemo(() => templates.filter(t =>
    !activeNames.has(t.name.toLowerCase())
  ), [templates, activeNames])

  function addRow(name: string) {
    setRows(prev => {
      const active = prev.filter(r => !r.deleted)
      const maxOrder = active.length > 0 ? Math.max(...active.map(r => r.sort_order)) + 10 : 10
      return [...prev, { key: _subRowKey++, origId: null, name, sort_order: maxOrder, deleted: false }]
    })
  }

  function moveRow(activeIndex: number, dir: -1 | 1) {
    setRows(prev => {
      const active = prev.filter(r => !r.deleted)
      const target = activeIndex + dir
      if (target < 0 || target >= active.length) return prev
      const reordered = [...active]
      ;[reordered[activeIndex], reordered[target]] = [reordered[target], reordered[activeIndex]]
      const withOrder = reordered.map((r, i) => ({ ...r, sort_order: (i + 1) * 10 }))
      return [...withOrder, ...prev.filter(r => r.deleted)]
    })
  }

  function deleteRow(activeIndex: number) {
    setRows(prev => {
      const active = prev.filter(r => !r.deleted)
      const row = active[activeIndex]
      if (row.origId) return prev.map(r => r.key === row.key ? { ...r, deleted: true } : r)
      return prev.filter(r => r.key !== row.key)
    })
  }

  function renameRow(activeIndex: number, name: string) {
    setRows(prev => {
      const active = prev.filter(r => !r.deleted)
      const row = active[activeIndex]
      return prev.map(r => r.key === row.key ? { ...r, name } : r)
    })
  }

  function addCustom() {
    const trimmed = customName.trim()
    if (!trimmed || activeNames.has(trimmed.toLowerCase())) return
    addRow(trimmed)
    setCustomName('')
  }

  async function handleSave() {
    setSaving(true)
    try {
      const active = rows.filter(r => !r.deleted)
      const deleted = rows.filter(r => r.deleted && r.origId)

      for (const row of deleted) {
        const { error } = await supabase.from('subprojects').delete().eq('id', row.origId!)
        if (error) throw error
      }

      for (const [i, row] of active.entries()) {
        const sortOrder = (i + 1) * 10
        if (row.origId) {
          const orig = subprojects.find(s => s.id === row.origId)
          if (!orig || orig.name !== row.name || orig.sort_order !== sortOrder) {
            const { error } = await supabase.from('subprojects')
              .update({ name: row.name, sort_order: sortOrder }).eq('id', row.origId)
            if (error) throw error
          }
        } else {
          const { error } = await supabase.from('subprojects')
            .insert({ project_id: projectId, name: row.name, sort_order: sortOrder })
          if (error) throw error
        }
      }

      toast.success('Podprojekty uloženy.')
      onSaved()
      onClose()
    } catch {
      toast.error('Chyba při ukládání')
    } finally {
      setSaving(false)
    }
  }

  const sectionLabel = "text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2"

  return (
    <Modal open={open} onClose={onClose} title="Spravovat podprojekty" size="md">
      <div className="space-y-5">
        <div>
          <p className={sectionLabel}>Podprojekty ({activeRows.length})</p>
          {activeRows.length === 0 ? (
            <p className="text-sm text-gray-400 py-1">Žádné podprojekty.</p>
          ) : (
            <div className="space-y-1.5">
              {activeRows.map((row, i) => (
                <div key={row.key} className="flex items-center gap-1.5">
                  <input
                    value={row.name}
                    onChange={e => renameRow(i, e.target.value)}
                    className={`flex-1 min-w-0 ${inputClass} py-1.5 text-sm`}
                  />
                  <button disabled={i === 0} onClick={() => moveRow(i, -1)}
                    className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 shrink-0" title="Nahoru">
                    <ChevronUp size={15} />
                  </button>
                  <button disabled={i === activeRows.length - 1} onClick={() => moveRow(i, 1)}
                    className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 shrink-0" title="Dolů">
                    <ChevronDown size={15} />
                  </button>
                  <button onClick={() => deleteRow(i)}
                    className="p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 shrink-0" title="Odebrat">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {availableRefs.length > 0 && (
          <div>
            <p className={sectionLabel}>Přidat z 3DMax</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1 gap-x-4 max-h-44 overflow-y-auto pr-1">
              {availableRefs.map(r => {
                const full = (r.code ? r.code + ' ' : '') + r.name
                return (
                  <label key={r.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 py-0.5 select-none">
                    <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 accent-indigo-600"
                      onChange={e => { if (e.target.checked) addRow(full) }} />
                    {full}
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {availableTpls.length > 0 && (
          <div>
            <p className={sectionLabel}>Přidat ze šablon</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1 gap-x-4 max-h-36 overflow-y-auto pr-1">
              {availableTpls.map(t => (
                <label key={t.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 py-0.5 select-none">
                  <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 accent-indigo-600"
                    onChange={e => { if (e.target.checked) addRow(t.name) }} />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className={sectionLabel}>Přidat vlastní</p>
          <div className="flex gap-2">
            <input
              value={customName}
              onChange={e => setCustomName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addCustom() }}
              placeholder="Název podprojektu…"
              className={`flex-1 ${inputClass} py-1.5 text-sm`}
            />
            <Button size="sm" variant="secondary"
              onClick={addCustom}
              disabled={!customName.trim() || activeNames.has(customName.trim().toLowerCase())}>
              <Plus size={14} /> Přidat
            </Button>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button variant="secondary" onClick={onClose}>Zrušit</Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>Uložit</Button>
        </div>
      </div>
    </Modal>
  )
}
