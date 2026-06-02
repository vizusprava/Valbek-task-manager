import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { PRIORITY_LABELS } from '@/lib/utils'
import type { Subproject, Profile, TaskWithRelations, TaskStatus, TaskPriority, TaskTemplate } from '@/lib/types'
import { inputClass } from './shared'

export function BulkCreateTasksModal({ open, onClose, projectId, subprojects, members, tasks, onCreated }: {
  open: boolean; onClose: () => void; projectId: string
  subprojects: Subproject[]; members: Profile[]
  tasks: TaskWithRelations[]; onCreated: () => void
}) {
  const [tab,          setTab]          = useState<'series' | 'copy'>('series')
  const [prefix,       setPrefix]       = useState('')
  const [suffix,       setSuffix]       = useState('')
  const [startNum,     setStartNum]     = useState<number | ''>('')
  const [endNum,       setEndNum]       = useState<number | ''>('')
  const [subprojectId, setSubprojectId] = useState('')
  const [priority,     setPriority]     = useState<TaskPriority>('medium')
  const [dueDate,      setDueDate]      = useState('')
  const [filePath,     setFilePath]     = useState('')
  const [description,  setDescription]  = useState('')
  const [assignedToId, setAssignedToId] = useState('')
  const [templateId,   setTemplateId]   = useState('')
  const [copyIds,      setCopyIds]      = useState<Set<string>>(new Set())
  const [copyTarget,   setCopyTarget]   = useState('')
  const [copyReset,    setCopyReset]    = useState(true)
  const [creating,     setCreating]     = useState(false)

  const { data: templates = [] } = useQuery<TaskTemplate[]>({
    queryKey: ['task-templates'],
    queryFn: async () => {
      const { data } = await supabase.from('task_templates').select('*').order('name')
      return (data || []) as TaskTemplate[]
    },
    enabled: open,
  })

  useEffect(() => {
    if (!open) {
      setTab('series'); setPrefix(''); setSuffix(''); setStartNum(1); setEndNum(10)
      setSubprojectId(''); setPriority('medium'); setDueDate(''); setFilePath('')
      setDescription(''); setAssignedToId(''); setTemplateId('')
      setStartNum(''); setEndNum('')
      setCopyIds(new Set()); setCopyTarget(''); setCopyReset(true)
    }
  }, [open])

  function applyTemplate(id: string) {
    setTemplateId(id)
    const tpl = templates.find(t => t.id === id)
    if (tpl) { setPrefix(tpl.title + ' '); setDescription(tpl.description ?? ''); setPriority(tpl.priority) }
    else      { setPrefix(''); setDescription(''); setPriority('medium') }
  }

  const seriesCount = (startNum !== '' && endNum !== '' && endNum >= startNum)
    ? Math.min(endNum - startNum + 1, 30) : 0
  const preview = Array.from({ length: Math.min(seriesCount, 5) }, (_, i) =>
    `${prefix}${(startNum as number) + i}${suffix}`.trim()
  )

  async function handleCreateSeries() {
    if (!prefix.trim() && !suffix.trim()) return
    setCreating(true)
    const maxOrder = tasks.filter(t => subprojectId ? t.subproject_id === subprojectId : !t.subproject_id)
      .reduce((m, t) => Math.max(m, t.sort_order), 0)
    const rows = Array.from({ length: seriesCount }, (_, i) => ({
      project_id: projectId,
      title: `${prefix}${(startNum as number) + i}${suffix}`.trim(),
      description: description.trim() || null,
      priority, status: 'neudělano' as TaskStatus,
      subproject_id: subprojectId || null,
      assigned_to: assignedToId || null,
      due_date: dueDate || null,
      file_path: filePath.trim() || null,
      sort_order: maxOrder + i + 1,
    }))
    const { data, error } = await supabase.from('tasks').insert(rows).select('id')
    if (error) { toast.error(error.message); setCreating(false); return }
    if (assignedToId && data) {
      await supabase.from('task_assignees').insert(data.map(t => ({ task_id: t.id, user_id: assignedToId })))
    }
    setCreating(false)
    toast.success(`Vytvořeno ${seriesCount} úkolů.`)
    onCreated(); onClose()
  }

  async function handleCopyTasks() {
    if (copyIds.size === 0) return
    setCreating(true)
    const rows = tasks.filter(t => copyIds.has(t.id)).map(t => ({
      project_id: projectId, title: t.title, description: t.description, priority: t.priority,
      status: copyReset ? 'neudělano' as TaskStatus : t.status,
      subproject_id: copyTarget || t.subproject_id, assigned_to: null,
      due_date: null, file_path: t.file_path, sort_order: t.sort_order + 1000,
    }))
    const { error } = await supabase.from('tasks').insert(rows)
    if (error) { toast.error(error.message); setCreating(false); return }
    setCreating(false)
    toast.success(`Zkopírováno ${copyIds.size} úkolů.`)
    onCreated(); onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Hromadné vytvoření úkolů" size="md">
      <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg mb-4">
        {(['series', 'copy'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${tab === t ? 'bg-white dark:bg-gray-700 shadow-sm text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            {t === 'series' ? 'Číselná série' : 'Kopírovat úkoly'}
          </button>
        ))}
      </div>

      {tab === 'series' && (
        <div className="space-y-3">
          {templates.length > 0 && (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Ze šablony (volitelné)</label>
              <select value={templateId} onChange={e => applyTemplate(e.target.value)} className={inputClass}>
                <option value="">– bez šablony –</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1">
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Prefix názvu</label>
              <input value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="3D model " className={inputClass} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Od čísla</label>
              <input type="number" value={startNum} onChange={e => setStartNum(e.target.value === '' ? '' : Number(e.target.value))} placeholder="201" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Do čísla (max +30)</label>
              <input type="number" value={endNum} onChange={e => setEndNum(e.target.value === '' ? '' : Number(e.target.value))} placeholder="215" className={inputClass} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Suffix (volitelný)</label>
            <input value={suffix} onChange={e => setSuffix(e.target.value)} placeholder=" DWG" className={inputClass} />
          </div>
          {(prefix.trim() || suffix.trim()) && seriesCount > 0 && (
            <div className="p-2.5 bg-gray-50 dark:bg-gray-800/60 rounded-lg text-xs text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700">
              <p className="font-medium mb-1 text-gray-700 dark:text-gray-300">Náhled ({seriesCount} úkolů):</p>
              <ul className="space-y-0.5">
                {preview.map((t, i) => <li key={i} className="truncate">{t}</li>)}
                {seriesCount > 5 && <li className="text-gray-400 italic">… a dalších {seriesCount - 5}</li>}
              </ul>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Podprojekt</label>
              <select value={subprojectId} onChange={e => setSubprojectId(e.target.value)} className={inputClass}>
                <option value="">Bez podprojektu</option>
                {subprojects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Priorita</label>
              <select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)} className={inputClass}>
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Přiřadit</label>
              <select value={assignedToId} onChange={e => setAssignedToId(e.target.value)} className={inputClass}>
                <option value="">– nikdo –</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Termín</label>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputClass} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Cesta ke složce (společná)</label>
            <input value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="\\server\share\projekt" className={inputClass} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Popis (společný)</label>
            <textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} className={`${inputClass} resize-none`} />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
            <Button variant="secondary" onClick={onClose}>Zrušit</Button>
            <Button variant="primary" loading={creating}
              disabled={(!prefix.trim() && !suffix.trim()) || seriesCount === 0 || startNum === '' || endNum === ''}
              onClick={handleCreateSeries}>
              Vytvořit {seriesCount > 0 ? `${seriesCount} úkolů` : ''}
            </Button>
          </div>
        </div>
      )}

      {tab === 'copy' && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Vybrat úkoly ke kopírování</label>
            <div className="max-h-52 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-50 dark:divide-gray-800">
              {tasks.length === 0
                ? <p className="text-sm text-gray-400 text-center py-4">Žádné úkoly.</p>
                : tasks.map(t => (
                  <label key={t.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                    <input type="checkbox" checked={copyIds.has(t.id)}
                      onChange={() => setCopyIds(prev => { const n = new Set(prev); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n })}
                      className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 accent-indigo-600" />
                    <span className="text-sm text-gray-700 dark:text-gray-300 truncate flex-1">{t.title}</span>
                  </label>
                ))
              }
            </div>
            <div className="flex gap-3 mt-1">
              <button className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                onClick={() => setCopyIds(new Set(tasks.map(t => t.id)))}>Vybrat vše</button>
              <button className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:underline"
                onClick={() => setCopyIds(new Set())}>Zrušit výběr</button>
              <span className="text-xs text-gray-400 ml-auto">{copyIds.size} vybráno</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 items-end">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Cílový podprojekt</label>
              <select value={copyTarget} onChange={e => setCopyTarget(e.target.value)} className={inputClass}>
                <option value="">Zachovat původní</option>
                {subprojects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer pb-0.5">
              <input type="checkbox" checked={copyReset} onChange={e => setCopyReset(e.target.checked)}
                className="rounded border-gray-300 text-indigo-600 accent-indigo-600" />
              Reset stavu na „Neudělano"
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
            <Button variant="secondary" onClick={onClose}>Zrušit</Button>
            <Button variant="primary" loading={creating} disabled={copyIds.size === 0} onClick={handleCopyTasks}>
              Kopírovat {copyIds.size > 0 ? `${copyIds.size} úkolů` : ''}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
