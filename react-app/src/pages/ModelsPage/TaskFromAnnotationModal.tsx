import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MapPin } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { STATUS_LABELS, PRIORITY_LABELS } from '@/lib/utils'
import type { Subproject, Profile, TaskStatus, TaskPriority, ModelFile } from '@/lib/types'
import type { ViewerAnnotation } from '@/viewer-core'
import { inputClass } from '../ProjectPage/shared'

/** Založení úkolu přímo z anotace ve 3D vieweru — předvyplní text, naváže model + anotaci. */
export function TaskFromAnnotationModal({ open, onClose, annotation, model, projects, onCreated }: {
  open: boolean
  onClose: () => void
  annotation: ViewerAnnotation | null
  model: ModelFile
  projects: { id: string; name: string }[]
  onCreated: () => void
}) {
  const { profile } = useAuthStore()
  const [projectId,    setProjectId]    = useState('')
  const [title,        setTitle]        = useState('')
  const [desc,         setDesc]         = useState('')
  const [status,       setStatus]       = useState<TaskStatus>('neudělano')
  const [priority,     setPriority]     = useState<TaskPriority>('medium')
  const [assignedTo,   setAssignedTo]   = useState('')
  const [dueDate,      setDueDate]      = useState('')
  const [subprojectId, setSubprojectId] = useState('')
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState('')

  // při otevření předvyplníme z anotace; projekt přednastavíme podle modelu
  useEffect(() => {
    if (open && annotation) {
      const text = annotation.text.trim()
      const firstLine = text.split('\n')[0]
      setProjectId(model.project_id ?? '')
      setTitle(firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine)
      setDesc(firstLine !== text ? text : '')
      setStatus('neudělano'); setPriority('medium')
      setAssignedTo(profile?.id ?? ''); setDueDate(''); setSubprojectId('')
      setError('')
    }
  }, [open, annotation, model, profile])

  const { data: members = [] } = useQuery({
    queryKey: ['members_for_task', projectId],
    queryFn: async () => {
      const { data } = await supabase
        .from('projects')
        .select('project_members(profiles(id, name, role, initials, color))')
        .eq('id', projectId)
        .single()
      const rows = (data as { project_members: { profiles: Profile }[] } | null)?.project_members ?? []
      return rows.map(m => m.profiles).filter(Boolean) as Profile[]
    },
    enabled: open && !!projectId,
  })

  const { data: subprojects = [] } = useQuery({
    queryKey: ['subprojects_for_task', projectId],
    queryFn: async () => {
      const { data } = await supabase.from('subprojects').select('*').eq('project_id', projectId).order('sort_order')
      return (data ?? []) as Subproject[]
    },
    enabled: open && !!projectId,
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || !annotation) return
    if (!projectId) { setError('Vyberte projekt, do kterého úkol patří.'); return }
    setLoading(true); setError('')

    const { data: maxTask } = await supabase.from('tasks').select('sort_order').eq('project_id', projectId).order('sort_order', { ascending: false }).limit(1).single()
    const maxOrder = (maxTask?.sort_order ?? 0) + 10

    const { data: newTask, error: err } = await supabase.from('tasks').insert({
      project_id: projectId, title: title.trim(), description: desc.trim() || null,
      status, priority, assigned_to: assignedTo || null, due_date: dueDate || null,
      subproject_id: subprojectId || null,
      model_id: model.id,
      annotation_id: annotation.id,
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
    }
    toast.success('Úkol vytvořen z anotace!')
    onCreated(); onClose()
  }

  if (!annotation) return null

  return (
    <Modal open={open} onClose={onClose} title="Nový úkol z anotace" size="md" zClass="z-[10000]">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/20 p-3">
          <MapPin size={14} className="text-indigo-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-indigo-600 dark:text-indigo-400">{model.name}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {annotation.object_name ? `[${annotation.object_name}] ` : ''}{annotation.text}
            </div>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Projekt *</label>
          <select required value={projectId} onChange={e => { setProjectId(e.target.value); setSubprojectId('') }} className={inputClass}>
            <option value="">— vyberte projekt —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Název úkolu *</label>
          <input required value={title} onChange={e => setTitle(e.target.value)} placeholder="Co je třeba udělat?" className={inputClass} />
        </div>
        {subprojects.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Podprojekt</label>
            <select value={subprojectId} onChange={e => setSubprojectId(e.target.value)} className={inputClass}>
              <option value="">– bez podprojektu –</option>
              {subprojects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
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
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button type="button" variant="secondary" onClick={onClose}>Zrušit</Button>
          <Button type="submit" variant="primary" loading={loading}>Vytvořit úkol</Button>
        </div>
      </form>
    </Modal>
  )
}
