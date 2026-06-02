import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MapPin, Paperclip, X, FileText } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { STATUS_LABELS, PRIORITY_LABELS } from '@/lib/utils'
import type { Subproject, Profile, TaskStatus, TaskPriority, TaskTemplate } from '@/lib/types'
import { inputClass } from './shared'

export function CreateTaskModal({ open, onClose, projectId, subprojects, members, defaultSubprojectId, onCreated }: {
  open: boolean; onClose: () => void; projectId: string
  subprojects: Subproject[]; members: Profile[]
  defaultSubprojectId?: string; onCreated: () => void
}) {
  const { profile } = useAuthStore()
  const [title,       setTitle]       = useState('')
  const [desc,        setDesc]        = useState('')
  const [status,      setStatus]      = useState<TaskStatus>('neudělano')
  const [priority,    setPriority]    = useState<TaskPriority>('medium')
  const [assignedTo,  setAssignedTo]  = useState('')
  const [dueDate,     setDueDate]     = useState('')
  const [subprojectId,setSubprojectId]= useState(defaultSubprojectId ?? '')
  const [filePath,    setFilePath]    = useState('')
  const [annotationId, setAnnotationId] = useState<string | null>(null)
  const [annModelId,   setAnnModelId]   = useState('')
  const [annPickerOpen, setAnnPickerOpen] = useState(false)
  const [stagedFiles,  setStagedFiles]  = useState<File[]>([])
  const stagedInputRef = useRef<HTMLInputElement>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')

  const { data: templates = [] } = useQuery({
    queryKey: ['task-templates'],
    queryFn: async () => {
      const { data } = await supabase.from('task_templates').select('*').order('name')
      return (data || []) as TaskTemplate[]
    },
    enabled: open,
  })

  const { data: pickerModels = [] } = useQuery({
    queryKey: ['picker_models'],
    queryFn: async () => {
      const { data } = await supabase.from('model_files').select('id, name').order('name')
      return (data || []) as { id: string; name: string }[]
    },
    enabled: annPickerOpen,
  })

  const { data: pickerAnnotations = [] } = useQuery({
    queryKey: ['picker_annotations', annModelId],
    queryFn: async () => {
      const { data } = await supabase.from('model_annotations').select('id, text, object_name').eq('model_id', annModelId).order('created_at')
      return (data || []) as { id: string; text: string; object_name: string | null }[]
    },
    enabled: !!annModelId,
  })

  const selectedModelName = annModelId ? pickerModels.find(m => m.id === annModelId)?.name ?? '' : ''

  useEffect(() => {
    if (open) {
      setTitle(''); setDesc(''); setStatus('neudělano'); setPriority('medium')
      setAssignedTo(profile?.id ?? ''); setDueDate('')
      setSubprojectId(defaultSubprojectId ?? ''); setFilePath('')
      setAnnotationId(null); setAnnModelId(''); setAnnPickerOpen(false); setStagedFiles([]); setError('')
    }
  }, [open, defaultSubprojectId, profile])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    setLoading(true); setError('')
    const { data: maxTask } = await supabase.from('tasks').select('sort_order').eq('project_id', projectId).order('sort_order', { ascending: false }).limit(1).single()
    const maxOrder = (maxTask?.sort_order ?? 0) + 10

    const { data: newTask, error: err } = await supabase.from('tasks').insert({
      project_id: projectId, title: title.trim(), description: desc.trim() || null,
      status, priority, assigned_to: assignedTo || null, due_date: dueDate || null,
      subproject_id: subprojectId || null, file_path: filePath.trim() || null,
      model_id: annModelId || null,
      annotation_id: annotationId || null,
      created_by: profile.id, updated_by: profile.id, sort_order: maxOrder,
    }).select('id, title').single()

    setLoading(false)
    if (err) { setError(err.message); return }
    if (newTask) {
      await supabase.from('task_activity').insert({ task_id: newTask.id, user_id: profile.id, field: 'created', old_value: null, new_value: newTask.title })
      if (assignedTo) {
        await supabase.from('task_assignees').insert({ task_id: newTask.id, user_id: assignedTo })
      }
      if (assignedTo && assignedTo !== profile.id) {
        await supabase.from('notifications').insert({
          user_id: assignedTo, type: 'task_assigned',
          message: `Byl/a jsi přiřazen/a k úkolu: ${newTask.title}`,
          task_id: newTask.id, project_id: projectId,
        })
      }
      for (const file of stagedFiles) {
        const path = `task-files/${newTask.id}/${Date.now()}_${file.name}`
        const { error: upErr } = await supabase.storage.from('attachments').upload(path, file)
        if (!upErr) {
          await supabase.from('task_attachments').insert({ task_id: newTask.id, name: file.name, file_path: path, mime_type: file.type || null, file_size: file.size, created_by: profile.id })
        }
      }
    }
    toast.success('Úkol vytvořen!')
    onCreated(); onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Nový úkol" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {templates.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Z šablony</label>
            <select defaultValue="" onChange={e => {
              const t = templates.find(t => t.id === e.target.value)
              if (t) { setTitle(t.title); setDesc(t.description ?? ''); setPriority(t.priority) }
              e.currentTarget.value = ''
            }} className={inputClass}>
              <option value="">— vybrat šablonu —</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Název úkolu *</label>
          <input required value={title} onChange={e => setTitle(e.target.value)} placeholder="Co je třeba udělat?" className={inputClass} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Podprojekt</label>
          <select value={subprojectId} onChange={e => setSubprojectId(e.target.value)} className={inputClass}>
            <option value="">– bez podprojektu –</option>
            {subprojects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Popis</label>
          <textarea rows={2} value={desc} onChange={e => setDesc(e.target.value)} className={`${inputClass} resize-none`} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Stav</label>
            <select value={status} onChange={e => setStatus(e.target.value as TaskStatus)} className={inputClass}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Priorita</label>
            <select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)} className={inputClass}>
              {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Přiřazený</label>
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className={inputClass}>
              <option value="">– nikdo –</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Termín</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputClass} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cesta k souboru</label>
          <input type="text" value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="\\server\share\projekt" className={inputClass} />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Odkaz na 3D model</label>
            {annModelId && (
              <button type="button" onClick={() => { setAnnotationId(null); setAnnModelId(''); setAnnPickerOpen(false) }}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors">Zrušit</button>
            )}
          </div>
          {annModelId ? (
            <div className="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/20 p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <MapPin size={13} className="text-indigo-500 shrink-0" />
                <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">{selectedModelName}</span>
              </div>
              <select value={annotationId ?? ''} onChange={e => setAnnotationId(e.target.value || null)} className={inputClass}>
                <option value="">— bez anotace —</option>
                {pickerAnnotations.map(a => (
                  <option key={a.id} value={a.id}>{a.object_name ? `[${a.object_name}] ` : ''}{a.text.slice(0, 80)}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-2">
              <button type="button" onClick={() => setAnnPickerOpen(v => !v)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${annPickerOpen ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400' : 'border-dashed border-gray-300 dark:border-gray-600 text-gray-400 hover:border-indigo-400 hover:text-indigo-500'}`}>
                <MapPin size={13} />
                {annPickerOpen ? 'Skrýt výběr' : 'Přidat odkaz na 3D model…'}
              </button>
              {annPickerOpen && (
                <div className="pl-1">
                  <select value={annModelId} onChange={e => { setAnnModelId(e.target.value); setAnnotationId(null) }} className={inputClass}>
                    <option value="">— vyberte model —</option>
                    {pickerModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Přílohy</label>
            {stagedFiles.length > 0 && (
              <span className="text-xs text-gray-400">{stagedFiles.length} soubor{stagedFiles.length === 1 ? '' : stagedFiles.length < 5 ? 'y' : 'ů'}</span>
            )}
          </div>
          {stagedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {stagedFiles.map((f, i) => {
                const isImg = f.type.startsWith('image/')
                const previewUrl = isImg ? URL.createObjectURL(f) : null
                return (
                  <div key={i} className="relative group w-16 h-16 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-800 flex items-center justify-center">
                    {previewUrl
                      ? <img src={previewUrl} alt={f.name} className="w-full h-full object-cover" />
                      : <FileText size={22} className="text-gray-300 dark:text-gray-600" />
                    }
                    <button type="button"
                      onClick={() => setStagedFiles(prev => prev.filter((_, j) => j !== i))}
                      className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity text-white">
                      <X size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <button type="button"
            onClick={() => stagedInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-400 hover:border-indigo-400 hover:text-indigo-500 transition-colors">
            <Paperclip size={14} /> Přiložit soubory…
          </button>
          <input ref={stagedInputRef} type="file" multiple className="hidden"
            onChange={e => { setStagedFiles(prev => [...prev, ...Array.from(e.target.files || [])]); e.target.value = '' }} />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button type="button" variant="secondary" onClick={onClose}>Zrušit</Button>
          <Button type="submit" variant="primary" loading={loading}>Vytvořit úkol</Button>
        </div>
      </form>
    </Modal>
  )
}
