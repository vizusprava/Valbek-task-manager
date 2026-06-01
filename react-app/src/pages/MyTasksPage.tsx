import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MessageSquare, Send, Trash2, Paperclip, MapPin, ExternalLink } from 'lucide-react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageLayout } from '@/components/layout/PageLayout'
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge'
import { InlineSelect, InlineDateInput } from '@/components/ui/InlineEdit'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatDate, formatDateTime, isOverdue, STATUS_LABELS, PRIORITY_LABELS } from '@/lib/utils'
import type { TaskWithRelations, Comment, TaskStatus, TaskPriority } from '@/lib/types'

// ── Task Detail Modal ─────────────────────────────────────────

function TaskDetailModal({ task, onClose, onSaved }: {
  task: TaskWithRelations | null
  onClose: () => void
  onSaved: () => void
}) {
  const { profile, isAdmin } = useAuthStore()
  const admin   = isAdmin()
  const canEdit = admin || task?.assigned_to === profile?.id || task?.task_assignees?.some(a => a.user_id === profile?.id)
  const confirm = useConfirm()

  const [status,        setStatus]        = useState<TaskStatus>(task?.status ?? 'neudělano')
  const [priority,      setPriority]      = useState<TaskPriority>(task?.priority ?? 'medium')
  const [dueDate,       setDueDate]       = useState(task?.due_date ?? '')
  const [desc,          setDesc]          = useState(task?.description ?? '')
  const [annotationId,  setAnnotationId]  = useState<string | null>(null)
  const [annModelId,    setAnnModelId]    = useState('')
  const [annPickerOpen, setAnnPickerOpen] = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [comment,        setComment]        = useState('')
  const [attachedImages, setAttachedImages] = useState<string[]>([])
  const [sending,        setSending]        = useState(false)
  const [error,      setError]      = useState('')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!lightboxSrc) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxSrc(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxSrc])

  async function uploadImage(file: File): Promise<string | null> {
    const ext = file.name.split('.').pop() || 'png'
    const path = `comment-images/${task?.id}/${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage.from('attachments').upload(path, file)
    if (upErr) { toast.error('Nepodařilo se nahrát obrázek'); return null }
    return supabase.storage.from('attachments').getPublicUrl(path).data.publicUrl
  }

  async function handleImagePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    if (!item) return
    e.preventDefault()
    const file = item.getAsFile()
    if (!file) return
    const url = await uploadImage(file)
    if (url) setAttachedImages(prev => [...prev, url])
  }

  async function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const url = await uploadImage(file)
    if (url) setAttachedImages(prev => [...prev, url])
    e.target.value = ''
  }

  useEffect(() => {
    if (task) {
      setStatus(task.status); setPriority(task.priority)
      setDueDate(task.due_date ?? ''); setDesc(task.description ?? '')
      setAnnotationId(task.annotation_id ?? null)
      setAnnModelId(task.annotation?.model_id ?? task.linked_model?.id ?? '')
      setAnnPickerOpen(false)
      setError(''); setComment(''); setAttachedImages([])
    }
  }, [task])

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

  const { data: comments = [], refetch: refetchComments } = useQuery<Comment[]>({
    queryKey: ['task-comments', task?.id],
    queryFn: async () => {
      const { data } = await supabase.from('comments').select('*, author:author_id(id, name)')
        .eq('task_id', task!.id).order('created_at', { ascending: true })
      return (data || []) as Comment[]
    },
    enabled: !!task,
  })

  useEffect(() => {
    if (!task) return
    const ch = supabase.channel(`comments-${task.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments', filter: `task_id=eq.${task.id}` },
        () => refetchComments())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [task?.id, refetchComments])

  async function handleSave() {
    if (!task || !profile) return
    setSaving(true); setError('')
    const { error: err } = await supabase.from('tasks').update({
      status, priority, due_date: dueDate || null, description: desc || null,
      model_id: annModelId || null,
      annotation_id: annotationId || null, updated_by: profile.id,
    }).eq('id', task.id)
    setSaving(false)
    if (err) { setError(err.message); return }
    toast.success('Uloženo.')
    onSaved()
    onClose()
  }

  async function handleAddComment() {
    if (!comment.trim() && attachedImages.length === 0) return
    if (!task || !profile) return
    const text = [comment.trim(), ...attachedImages].filter(Boolean).join('\n')
    setSending(true)
    const { error: err } = await supabase.from('comments').insert({ task_id: task.id, author_id: profile.id, text })
    setSending(false)
    if (err) { toast.error(err.message); return }
    setComment(''); setAttachedImages([]); refetchComments()
  }

  async function handleDeleteComment(commentId: string) {
    if (!await confirm({ message: 'Smazat komentář?', confirmLabel: 'Smazat', variant: 'danger' })) return
    const { error: err } = await supabase.from('comments').delete().eq('id', commentId)
    if (err) { toast.error(err.message); return }
    refetchComments()
  }

  if (!task) return null
  const overdue = isOverdue(task.due_date) && task.status !== 'hotovo' && task.status !== 'schváleno'

  return (
    <>
    <Modal open={!!task} onClose={onClose} title={task.title} size="lg">
      <div className="space-y-5">
        {task.project && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Projekt: <Link to={`/project/${task.project_id}`} className="text-indigo-600 dark:text-indigo-400 hover:underline" onClick={onClose}>{task.project.name}</Link>
            {task.subproject && <span className="ml-2 px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">{task.subproject.name}</span>}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Popis */}
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Popis</label>
            {canEdit ? (
              <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300">{task.description || '–'}</p>
            )}
          </div>

          {/* Stav */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Stav</label>
            {canEdit ? (
              <select value={status} onChange={e => setStatus(e.target.value as TaskStatus)}
                className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : <StatusBadge status={task.status} />}
          </div>

          {/* Priorita */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Priorita</label>
            {canEdit ? (
              <select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)}
                className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : <PriorityBadge priority={task.priority} />}
          </div>

          {/* Termín */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Termín {overdue && <span className="ml-1 text-xs text-red-500 font-normal">Po termínu</span>}
            </label>
            {canEdit ? (
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            ) : (
              <span className={`text-sm ${overdue ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'}`}>{formatDate(task.due_date)}</span>
            )}
          </div>

          {/* Meta */}
          <div className="text-xs text-gray-400 space-y-1">
            <p>Vytvořil: <strong>{task.creator?.name || '?'}</strong> · {formatDate(task.created_at)}</p>
            {task.updater && <p>Upravil: <strong>{task.updater.name}</strong> · {formatDateTime(task.updated_at)}</p>}
          </div>
        </div>

        {/* 3D Model / Annotation link */}
        {canEdit ? (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Odkaz na 3D model</label>
              {annModelId && (
                <button type="button" onClick={() => { setAnnotationId(null); setAnnModelId(''); setAnnPickerOpen(false) }}
                  className="text-xs text-gray-400 hover:text-red-500 transition-colors">Zrušit</button>
              )}
            </div>
            {annModelId ? (() => {
              const dispModelName = task.annotation?.model?.name ?? task.linked_model?.name ?? (pickerModels.find(m => m.id === annModelId)?.name ?? annModelId)
              const linkUrl = `/models?model=${annModelId}${annotationId ? `&annotation=${annotationId}` : ''}`
              return (
                <div className="rounded-lg border border-indigo-200/60 dark:border-indigo-700/40 bg-indigo-50/50 dark:bg-indigo-900/15 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <MapPin size={13} className="text-indigo-500 shrink-0" />
                    <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400 flex-1 truncate">{dispModelName}</span>
                    <Link to={linkUrl} onClick={onClose}
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors">
                      <ExternalLink size={11} /> Otevřít v 3D
                    </Link>
                  </div>
                  <select value={annotationId ?? ''} onChange={e => setAnnotationId(e.target.value || null)}
                    className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="">— bez anotace —</option>
                    {pickerAnnotations.map(a => (
                      <option key={a.id} value={a.id}>{a.object_name ? `[${a.object_name}] ` : ''}{a.text.slice(0, 80)}</option>
                    ))}
                  </select>
                </div>
              )
            })() : (
              <div className="space-y-2">
                <button type="button" onClick={() => setAnnPickerOpen(v => !v)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${annPickerOpen ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400' : 'border-dashed border-gray-300 dark:border-gray-600 text-gray-400 hover:border-indigo-400 hover:text-indigo-500'}`}>
                  <MapPin size={13} />
                  {annPickerOpen ? 'Skrýt výběr' : 'Přidat odkaz na 3D model…'}
                </button>
                {annPickerOpen && (
                  <div className="pl-1">
                    <select value={annModelId} onChange={e => { setAnnModelId(e.target.value); setAnnotationId(null) }}
                      className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      <option value="">— vyberte model —</option>
                      {pickerModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (task.annotation || task.linked_model) ? (
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-indigo-200/60 dark:border-indigo-700/40 bg-indigo-50/50 dark:bg-indigo-900/15">
            <MapPin size={15} className="text-indigo-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-indigo-500 font-medium truncate">
                {task.annotation?.model?.name ?? task.linked_model?.name ?? 'Model'}
              </p>
              {task.annotation && <p className="text-sm text-gray-700 dark:text-gray-300 truncate mt-0.5">{task.annotation.text}</p>}
            </div>
            <Link
              to={`/models?model=${task.annotation?.model_id ?? task.linked_model?.id}${task.annotation ? `&annotation=${task.annotation.id}` : ''}`}
              onClick={onClose}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors">
              <ExternalLink size={12} /> Otevřít v 3D
            </Link>
          </div>
        ) : null}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {canEdit && (
          <div className="flex justify-end pt-2 border-t border-gray-100 dark:border-gray-800">
            <Button variant="primary" loading={saving} onClick={handleSave}>Uložit změny</Button>
          </div>
        )}

        {/* Komentáře */}
        <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
            <MessageSquare size={15} /> Komentáře
          </h3>

          <div className="space-y-3 max-h-48 overflow-y-auto">
            {comments.length === 0 ? (
              <p className="text-sm text-gray-400">Zatím žádné komentáře.</p>
            ) : comments.map(c => (
              <div key={c.id} className="flex gap-2 group">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{c.author?.name || '?'}</span>
                    <span className="text-xs text-gray-400">{formatDateTime(c.created_at)}</span>
                    {(admin || c.author_id === profile?.id) && (
                      <button onClick={() => handleDeleteComment(c.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-opacity">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  <div className="text-sm text-gray-700 dark:text-gray-300 mt-0.5">
                    {c.text.split('\n').map((line, i, arr) =>
                      /^https?:\/\/\S+\.(jpe?g|png|gif|webp)(\?\S*)?$/i.test(line.trim()) || /\/storage\/v1\/object\/public\//.test(line.trim())
                        ? <img key={i} src={line.trim()} alt="" className="max-w-full max-h-64 rounded-lg mt-1 block cursor-zoom-in" onClick={() => setLightboxSrc(line.trim())} />
                        : <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            {attachedImages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachedImages.map((url, i) => (
                  <div key={i} className="relative group">
                    <img src={url} alt="" className="h-16 w-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700 cursor-zoom-in"
                      onClick={() => setLightboxSrc(url)} />
                    <button onClick={() => setAttachedImages(prev => prev.filter((_, j) => j !== i))}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity leading-none">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <textarea rows={2} value={comment} onChange={e => setComment(e.target.value)}
                placeholder="Napište komentář… (Ctrl+V pro vložení screenshotu)"
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddComment() }}
                onPaste={handleImagePaste}
                className="flex-1 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
              <div className="flex flex-col gap-1 self-end">
                <button onClick={() => fileInputRef.current?.click()}
                  className="p-2 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 dark:hover:text-indigo-400 transition-colors"
                  title="Přiložit obrázek">
                  <Paperclip size={15} />
                </button>
                <Button variant="primary" size="sm" loading={sending} onClick={handleAddComment}>
                  <Send size={14} />
                </Button>
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileAttach} />
            </div>
          </div>
        </div>
      </div>
    </Modal>

    {lightboxSrc && createPortal(
      <div className="fixed inset-0 z-70 bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
        onClick={() => setLightboxSrc(null)}>
        <img src={lightboxSrc} alt="" className="max-w-full max-h-full rounded-lg shadow-2xl object-contain" />
      </div>,
      document.body
    )}
    </>
  )
}

// ── My Tasks Page ─────────────────────────────────────────────

type GroupBy = 'urgency' | 'project'

const URGENCY_CONFIG: Record<string, { label: string; dot: string; text: string }> = {
  overdue:   { label: 'Po termínu', dot: 'bg-red-500',     text: 'text-red-600 dark:text-red-400' },
  today:     { label: 'Dnes',       dot: 'bg-orange-500',  text: 'text-orange-600 dark:text-orange-400' },
  week:      { label: 'Tento týden',dot: 'bg-indigo-500',  text: 'text-indigo-600 dark:text-indigo-400' },
  later:     { label: 'Později',    dot: 'bg-gray-400',    text: 'text-gray-500 dark:text-gray-400' },
  schváleno: { label: 'Schváleno',  dot: 'bg-teal-500',    text: 'text-teal-600 dark:text-teal-400' },
  hotovo:    { label: 'Hotovo',     dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
}

function urgencyKey(t: TaskWithRelations): string {
  if (t.status === 'hotovo')    return 'hotovo'
  if (t.status === 'schváleno') return 'schváleno'
  if (!t.due_date) return 'later'
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const due   = new Date(t.due_date); due.setHours(0, 0, 0, 0)
  const diff  = Math.floor((due.getTime() - today.getTime()) / 86_400_000)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (diff <= 7)  return 'week'
  return 'later'
}

export function MyTasksPage() {
  const { profile } = useAuthStore()
  const queryClient = useQueryClient()

  const [filterStatus,   setFilterStatus]   = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [search,         setSearch]         = useState('')
  const [selectedTask,   setSelectedTask]   = useState<TaskWithRelations | null>(null)
  const [showDone,       setShowDone]       = useState(false)
  const [groupBy,        setGroupBy]        = useState<GroupBy>('urgency')
  const [collapsed,      setCollapsed]      = useState<Set<string>>(new Set())

  const { data: tasks = [], isLoading } = useQuery<TaskWithRelations[]>({
    queryKey: ['my-tasks', profile?.id],
    queryFn: async () => {
      const { data: assigneeRows } = await supabase
        .from('task_assignees').select('task_id').eq('user_id', profile!.id)
      const taskIds = (assigneeRows || []).map(r => r.task_id)
      if (taskIds.length === 0) return []
      const { data } = await supabase
        .from('tasks')
        .select('*, comments(count), project:project_id(id, name), subproject:subproject_id(id, name), assigned:assigned_to(id, name, initials, color), creator:created_by(id, name), updater:updated_by(id, name), task_assignees(user_id, profiles(id, name, initials, color)), linked_model:model_id(id, name), annotation:annotation_id(id, text, object_name, model_id, model:model_id(id, name))')
        .in('id', taskIds)
        .order('title', { ascending: true })
      return (data || []) as TaskWithRelations[]
    },
    enabled: !!profile,
  })

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['my-tasks'] })
  }, [queryClient])

  async function handleStatusChange(taskId: string, val: TaskStatus) {
    if (!profile) return
    await supabase.from('tasks').update({ status: val, updated_by: profile.id }).eq('id', taskId)
    invalidate()
  }

  async function handlePriorityChange(taskId: string, val: TaskPriority) {
    if (!profile) return
    await supabase.from('tasks').update({ priority: val, updated_by: profile.id }).eq('id', taskId)
    invalidate()
  }

  async function handleDueDateChange(taskId: string, val: string | null) {
    if (!profile) return
    await supabase.from('tasks').update({ due_date: val, updated_by: profile.id }).eq('id', taskId)
    invalidate()
  }

  useEffect(() => {
    const ch = supabase.channel('my-tasks-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, invalidate)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [invalidate])

  const stats = useMemo(() => {
    let overdue = 0, dueToday = 0, dueWeek = 0, done = 0
    for (const t of tasks) {
      const k = urgencyKey(t)
      if (k === 'overdue') overdue++
      else if (k === 'today') dueToday++
      else if (k === 'week')  dueWeek++
      else if (k === 'hotovo') done++
    }
    return { overdue, dueToday, dueWeek, done }
  }, [tasks])

  const filtered = useMemo(() => {
    let result = tasks
    if (!showDone)      result = result.filter(t => t.status !== 'hotovo' && t.status !== 'schváleno')
    if (filterStatus)   result = result.filter(t => t.status === filterStatus)
    if (filterPriority) result = result.filter(t => t.priority === filterPriority)
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.project?.name || '').toLowerCase().includes(q)
      )
    }
    return result
  }, [tasks, showDone, filterStatus, filterPriority, search])

  const groups = useMemo(() => {
    if (groupBy === 'project') {
      const map: Record<string, { id: string; label: string; projectId: string; tasks: TaskWithRelations[] }> = {}
      for (const t of filtered) {
        const key = t.project_id
        if (!map[key]) map[key] = { id: key, label: t.project?.name ?? '–', projectId: t.project_id, tasks: [] }
        map[key].tasks.push(t)
      }
      return Object.values(map)
    }
    const order = ['overdue', 'today', 'week', 'later', 'schváleno', 'hotovo']
    const map: Record<string, TaskWithRelations[]> = {}
    for (const t of filtered) {
      const k = urgencyKey(t)
      if (!map[k]) map[k] = []
      map[k].push(t)
    }
    return order.filter(k => map[k]?.length).map(k => ({
      id: k, label: URGENCY_CONFIG[k].label, projectId: '', tasks: map[k],
    }))
  }, [filtered, groupBy])

  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const inputClass = "px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"

  return (
    <PageLayout>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Moje úkoly</h1>
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {(['urgency', 'project'] as const).map(g => (
            <button key={g} onClick={() => setGroupBy(g)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${groupBy === g ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              {g === 'urgency' ? 'Podle urgence' : 'Podle projektu'}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      {!isLoading && tasks.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {stats.overdue > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
              {stats.overdue} po termínu
            </span>
          )}
          {stats.dueToday > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-500 inline-block" />
              {stats.dueToday} dnes
            </span>
          )}
          {stats.dueWeek > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 inline-block" />
              {stats.dueWeek} tento týden
            </span>
          )}
          {stats.done > 0 && (
            <button onClick={() => setShowDone(v => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${showDone ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 hover:text-emerald-700 dark:hover:text-emerald-400'}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              {stats.done} hotovo {showDone ? '(skrýt)' : '(zobrazit)'}
            </button>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input type="text" placeholder="Hledat…" value={search} onChange={e => setSearch(e.target.value)} className={`${inputClass} w-48`} />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className={inputClass}>
          <option value="">Všechny stavy</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className={inputClass}>
          <option value="">Všechny priority</option>
          {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {(filterStatus || filterPriority || search) && (
          <Button size="sm" variant="ghost" onClick={() => { setFilterStatus(''); setFilterPriority(''); setSearch('') }}>Zrušit filtry</Button>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : groups.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          {tasks.length === 0 ? 'Nemáte přiřazené žádné úkoly.' : 'Žádné úkoly odpovídající filtru.'}
        </div>
      ) : groups.map(group => {
        const cfg = URGENCY_CONFIG[group.id]
        const isCollapsed = collapsed.has(group.id)
        return (
          <div key={group.id} className="mb-5">
            {/* Group header */}
            <button
              onClick={() => toggleCollapse(group.id)}
              className="w-full flex items-center gap-2 mb-2 group text-left"
            >
              {cfg && <span className={`w-2 h-2 rounded-full ${cfg.dot} shrink-0`} />}
              {groupBy === 'urgency' ? (
                <span className={`text-sm font-semibold ${cfg?.text ?? 'text-gray-500 dark:text-gray-400'}`}>{group.label}</span>
              ) : (
                <Link to={`/project/${group.projectId}`} onClick={e => e.stopPropagation()}
                  className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide hover:text-indigo-600 dark:hover:text-indigo-400">
                  {group.label}
                </Link>
              )}
              <span className="text-xs text-gray-400 dark:text-gray-600 font-normal">({group.tasks.length})</span>
              <span className={`ml-auto text-gray-400 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M4.5 2.5l4 3.5-4 3.5V2.5z" />
                </svg>
              </span>
            </button>

            {!isCollapsed && (
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
                <table className="w-full text-sm table-fixed">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-800 text-xs text-gray-400 uppercase tracking-wide">
                      <th className="text-left px-4 py-2.5 font-medium">Úkol</th>
                      <th className="text-left px-4 py-2.5 font-medium w-36">Stav</th>
                      <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell w-28">Priorita</th>
                      <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell w-32">Termín</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.tasks.map(t => {
                      const overdue = isOverdue(t.due_date) && t.status !== 'hotovo'
                      const commentCount = t.comments?.[0]?.count ?? 0
                      return (
                        <tr key={t.id} onClick={() => setSelectedTask(t)}
                          className={`border-b border-gray-50 dark:border-gray-800 last:border-0 cursor-pointer
                            ${(t.status === 'hotovo' || t.status === 'schváleno') ? 'bg-emerald-50/60 hover:bg-emerald-50 dark:bg-emerald-900/10 dark:hover:bg-emerald-900/20'
                              : overdue ? 'bg-red-50/30 hover:bg-gray-50 dark:bg-red-900/5 dark:hover:bg-gray-800/50'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                          <td className="px-4 py-3">
                            <div className="flex items-start gap-2">
                              <span className={`font-medium ${t.status === 'hotovo' ? 'line-through text-emerald-700/60 dark:text-emerald-400/60' : overdue ? 'text-red-700 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>
                                {t.title}
                              </span>
                              {commentCount > 0 && (
                                <span className="flex items-center gap-0.5 text-xs text-gray-400 shrink-0">
                                  <MessageSquare size={11} />{commentCount}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              {groupBy === 'urgency' && t.project && (
                                <Link to={`/project/${t.project_id}`} onClick={e => e.stopPropagation()}
                                  className="text-xs text-indigo-500 dark:text-indigo-400 hover:underline">
                                  {t.project.name}
                                </Link>
                              )}
                              {t.subproject && <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">{t.subproject.name}</span>}
                            </div>
                            {t.description && <p className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">{t.description}</p>}
                          </td>
                          <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                            <InlineSelect<TaskStatus>
                              value={t.status} options={STATUS_LABELS}
                              onChange={val => handleStatusChange(t.id, val)}
                              renderBadge={() => <StatusBadge status={t.status} />}
                            />
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell" onClick={e => e.stopPropagation()}>
                            <InlineSelect<TaskPriority>
                              value={t.priority} options={PRIORITY_LABELS}
                              onChange={val => handlePriorityChange(t.id, val)}
                              renderBadge={() => <PriorityBadge priority={t.priority} />}
                            />
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell" onClick={e => e.stopPropagation()}>
                            <InlineDateInput value={t.due_date} onChange={val => handleDueDateChange(t.id, val)} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      <TaskDetailModal
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onSaved={invalidate}
      />
    </PageLayout>
  )
}
