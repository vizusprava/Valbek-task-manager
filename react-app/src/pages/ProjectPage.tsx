import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Copy, ChevronDown, ChevronUp, ChevronRight, MessageSquare, Send, Trash2, GripVertical, Settings, Paperclip, X, MoreHorizontal, CheckCircle } from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageLayout } from '@/components/layout/PageLayout'
import { Avatar } from '@/components/ui/Avatar'
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge'
import { InlineSelect, InlineDateInput } from '@/components/ui/InlineEdit'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { ManageTaskTemplatesModal } from '@/components/ui/TaskTemplatesModal'
import {
  formatDate, formatDateTime, isOverdue,
  STATUS_LABELS, PRIORITY_LABELS, copyToClipboard,
} from '@/lib/utils'
import type {
  Project, Profile, Subproject, TaskWithRelations, Comment,
  TaskStatus, TaskPriority, TaskTemplate,
} from '@/lib/types'

const inputClass = "w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"

function isImageUrl(s: string) {
  return /^https?:\/\/\S+\.(jpe?g|png|gif|webp)(\?\S*)?$/i.test(s)
    || /\/storage\/v1\/object\/public\//.test(s)
}

function CommentText({ text, onImageClick }: { text: string; onImageClick?: (src: string) => void }) {
  return (
    <>
      {text.split('\n').map((line, i, arr) =>
        isImageUrl(line.trim())
          ? <img key={i} src={line.trim()} alt=""
              className="max-w-full max-h-64 rounded-lg mt-1 block cursor-zoom-in"
              onClick={() => onImageClick?.(line.trim())}
            />
          : <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
      )}
    </>
  )
}

// ── Task Detail Modal ─────────────────────────────────────────

function TaskDetailModal({ task, subprojects, members, projectId, onClose, onSaved }: {
  task: TaskWithRelations | null
  subprojects: Subproject[]
  members: Profile[]
  projectId: string
  onClose: () => void
  onSaved: () => void
}) {
  const { profile, isAdmin } = useAuthStore()
  const admin   = isAdmin()
  const canEdit = admin || task?.assigned_to === profile?.id || task?.task_assignees?.some(a => a.user_id === profile?.id)
  const canDelete = admin || task?.created_by === profile?.id
  const confirm = useConfirm()

  const [title,          setTitle]          = useState('')
  const [status,         setStatus]         = useState<TaskStatus>('neudělano')
  const [priority,       setPriority]       = useState<TaskPriority>('medium')
  const [dueDate,        setDueDate]        = useState('')
  const [desc,           setDesc]           = useState('')
  const [subprojectId,   setSubprojectId]   = useState<string>('')
  const [assignedToIds,  setAssignedToIds]  = useState<string[]>([])
  const [filePath,       setFilePath]       = useState('')
  const [saving,      setSaving]      = useState(false)
  const [comment,        setComment]        = useState('')
  const [attachedImages, setAttachedImages] = useState<string[]>([])
  const [sending,        setSending]        = useState(false)
  const [error,       setError]       = useState('')
  const [activeTab,   setActiveTab]   = useState<'comments' | 'history'>('comments')
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
      setTitle(task.title); setStatus(task.status); setPriority(task.priority)
      setDueDate(task.due_date ?? ''); setDesc(task.description ?? '')
      setSubprojectId(task.subproject_id ?? '')
      setAssignedToIds(
        task.task_assignees && task.task_assignees.length > 0
          ? task.task_assignees.map(a => a.user_id)
          : task.assigned_to ? [task.assigned_to] : []
      )
      setFilePath(task.file_path ?? ''); setError('')
      setComment(''); setAttachedImages([])
    }
  }, [task])

  const { data: comments = [], refetch: refetchComments } = useQuery<Comment[]>({
    queryKey: ['task-comments', task?.id],
    queryFn: async () => {
      const { data } = await supabase.from('comments').select('*, author:author_id(id, name)')
        .eq('task_id', task!.id).order('created_at', { ascending: true })
      return (data || []) as Comment[]
    },
    enabled: !!task,
  })

  const { data: history = [] } = useQuery({
    queryKey: ['task-history', task?.id],
    queryFn: async () => {
      const { data } = await supabase.from('task_activity')
        .select('*, user:user_id(id, name)').eq('task_id', task!.id)
        .order('created_at', { ascending: false }).limit(50)
      return data || []
    },
    enabled: !!task && activeTab === 'history',
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
    if (!title.trim()) { setError('Název úkolu nesmí být prázdný.'); setSaving(false); return }
    const primaryAssignee = assignedToIds[0] || null
    const updateData = {
      title: title.trim(),
      status, priority, due_date: dueDate || null, description: desc || null,
      subproject_id: subprojectId || null, file_path: filePath.trim() || null,
      updated_by: profile.id,
      ...(admin ? { assigned_to: primaryAssignee } : {}),
    }
    const { error: err } = await supabase.from('tasks').update(updateData).eq('id', task.id)
    if (err) { setError(err.message); setSaving(false); return }

    if (admin) {
      const prevIds = task.task_assignees?.map(a => a.user_id) ?? (task.assigned_to ? [task.assigned_to] : [])
      await supabase.from('task_assignees').delete().eq('task_id', task.id)
      if (assignedToIds.length > 0) {
        await supabase.from('task_assignees').insert(assignedToIds.map(uid => ({ task_id: task.id, user_id: uid })))
      }
      const newIds = assignedToIds.filter(id => !prevIds.includes(id))
      for (const uid of newIds) {
        await supabase.from('notifications').insert({
          user_id: uid, type: 'task_assigned',
          message: `Byl/a jsi přiřazen/a k úkolu: ${task.title}`,
          task_id: task.id, project_id: projectId,
        })
      }
    }

    setSaving(false)
    toast.success('Úkol uložen.')
    onSaved(); onClose()
  }

  async function handleDelete() {
    if (!task) return
    if (!await confirm({ title: 'Smazat úkol', message: `Opravdu smazat úkol „${task.title}"? Tato akce je nevratná.`, confirmLabel: 'Smazat', variant: 'danger' })) return
    const { error: err } = await supabase.from('tasks').delete().eq('id', task.id)
    if (err) { toast.error(err.message); return }
    toast.success('Úkol smazán.')
    onSaved(); onClose()
  }

  async function handleAddComment() {
    if (!comment.trim() && attachedImages.length === 0) return
    if (!task || !profile) return
    const text = [comment.trim(), ...attachedImages].filter(Boolean).join('\n')
    setSending(true)
    const { error: err } = await supabase.from('comments').insert({ task_id: task.id, author_id: profile.id, text })
    setSending(false)
    if (err) { toast.error(err.message); return }
    setComment('')
    setAttachedImages([])
    refetchComments()
    if (task.assigned_to && task.assigned_to !== profile.id) {
      await supabase.from('notifications').insert({
        user_id: task.assigned_to, type: 'new_comment',
        message: `Nový komentář u úkolu: ${task.title}`,
        task_id: task.id, project_id: projectId,
      })
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (!await confirm({ message: 'Smazat komentář?', confirmLabel: 'Smazat', variant: 'danger' })) return
    const { error: err } = await supabase.from('comments').delete().eq('id', commentId)
    if (err) { toast.error(err.message); return }
    refetchComments()
  }

  if (!task) return null
  const overdue = isOverdue(task.due_date) && task.status !== 'hotovo'

  return (
    <>
    <Modal open={!!task} onClose={onClose} title={task.title} size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Název */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Název úkolu</label>
            {canEdit
              ? <input type="text" value={title} onChange={e => setTitle(e.target.value)} className={inputClass} />
              : <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{task.title}</p>
            }
          </div>

          {/* Popis */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Popis</label>
            {canEdit ? (
              <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)} className={`${inputClass} resize-none`} />
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300">{task.description || '–'}</p>
            )}
          </div>

          {/* Podprojekt */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Podprojekt</label>
            {canEdit ? (
              <select value={subprojectId} onChange={e => setSubprojectId(e.target.value)} className={inputClass}>
                <option value="">– bez podprojektu –</option>
                {subprojects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {subprojects.find(s => s.id === task.subproject_id)?.name ?? '–'}
              </span>
            )}
          </div>

          {/* Přiřazení */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Přiřazení</label>
            {admin ? (
              <div className="flex flex-wrap gap-2">
                {members.map(m => {
                  const checked = assignedToIds.includes(m.id)
                  return (
                    <label key={m.id} className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border cursor-pointer select-none transition-colors
                      ${checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-600 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                      <input type="checkbox" className="sr-only" checked={checked}
                        onChange={() => setAssignedToIds(prev => prev.includes(m.id) ? prev.filter(x => x !== m.id) : [...prev, m.id])} />
                      <Avatar name={m.name} initials={m.initials} color={m.color} small />
                      {m.name}
                    </label>
                  )
                })}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {task.task_assignees && task.task_assignees.length > 0
                  ? task.task_assignees.map(a => a.profiles ? (
                      <div key={a.user_id} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                        <Avatar name={a.profiles.name} initials={a.profiles.initials} color={a.profiles.color} small />
                        {a.profiles.name}
                      </div>
                    ) : null)
                  : <span className="text-sm text-gray-400">–</span>
                }
              </div>
            )}
          </div>

          {/* Stav */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Stav</label>
            {canEdit ? (
              <select value={status} onChange={e => setStatus(e.target.value as TaskStatus)} className={inputClass}>
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : <StatusBadge status={task.status} />}
          </div>

          {/* Priorita */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Priorita</label>
            {canEdit ? (
              <select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)} className={inputClass}>
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : <PriorityBadge priority={task.priority} />}
          </div>

          {/* Termín */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">
              Termín {overdue && <span className="text-red-500 normal-case">· Po termínu</span>}
            </label>
            {canEdit ? (
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputClass} />
            ) : (
              <span className={`text-sm ${overdue ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'}`}>{formatDate(task.due_date)}</span>
            )}
          </div>

          {/* Cesta k souboru */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Cesta k souboru</label>
            {canEdit ? (
              <input type="text" value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="\\server\share\projekt" className={inputClass} />
            ) : task.file_path ? (
              <div className="flex items-center gap-2">
                <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded truncate flex-1">{task.file_path}</code>
                <button onClick={() => copyToClipboard(task.file_path!).then(ok => ok && toast.success('Cesta zkopírována!'))}
                  className="shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><Copy size={14} /></button>
              </div>
            ) : <span className="text-sm text-gray-400">–</span>}
          </div>

          {/* Meta */}
          <div className="text-xs text-gray-400 space-y-1">
            <p>Vytvořil: <strong>{task.creator?.name || '?'}</strong> · {formatDate(task.created_at)}</p>
            {task.updater && <p>Upravil: <strong>{task.updater.name}</strong> · {formatDateTime(task.updated_at)}</p>}
          </div>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {canEdit && (
          <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-gray-800">
            {canDelete && (
              <Button variant="danger" size="sm" onClick={handleDelete}>Smazat úkol</Button>
            )}
            <div className="ml-auto">
              <Button variant="primary" loading={saving} onClick={handleSave}>Uložit změny</Button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
          <div className="flex gap-4 mb-4 border-b border-gray-100 dark:border-gray-800">
            {(['comments', 'history'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`pb-2 text-sm font-medium border-b-2 transition-colors ${activeTab === tab ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}>
                {tab === 'comments' ? `Komentáře (${comments.length})` : 'Historie'}
              </button>
            ))}
          </div>

          {activeTab === 'comments' && (
            <div className="space-y-3">
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
                      <div className="text-sm text-gray-700 dark:text-gray-300 mt-0.5"><CommentText text={c.text} onImageClick={setLightboxSrc} /></div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <div className="flex-1 space-y-2">
                  <textarea rows={2} value={comment} onChange={e => setComment(e.target.value)}
                    placeholder="Napište komentář…"
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddComment() }}
                    onPaste={handleImagePaste}
                    className={`w-full resize-none ${inputClass}`} />
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
                </div>
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
          )}

          {activeTab === 'history' && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {history.length === 0 ? (
                <p className="text-sm text-gray-400">Žádná historie.</p>
              ) : history.map((h: { id: string; field: string; old_value: string | null; new_value: string | null; created_at: string; user?: { name: string } }) => (
                <div key={h.id} className="text-xs text-gray-500 dark:text-gray-400 flex gap-2">
                  <span className="text-gray-400">{formatDateTime(h.created_at)}</span>
                  <span><strong>{h.user?.name}</strong> změnil <em>{h.field}</em>: {h.old_value ?? '–'} → {h.new_value ?? '–'}</span>
                </div>
              ))}
            </div>
          )}
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

// ── Create Task Modal ─────────────────────────────────────────

function CreateTaskModal({ open, onClose, projectId, subprojects, members, defaultSubprojectId, onCreated }: {
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
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')

  const { data: templates = [] } = useQuery({
    queryKey: ['task-templates'],
    queryFn: async () => {
      const { data } = await supabase.from('task_templates').select('*').order('name')
      return (data || []) as import('@/lib/types').TaskTemplate[]
    },
    enabled: open,
  })

  useEffect(() => {
    if (open) {
      setTitle(''); setDesc(''); setStatus('neudělano'); setPriority('medium')
      setAssignedTo(profile?.id ?? ''); setDueDate('')
      setSubprojectId(defaultSubprojectId ?? ''); setFilePath(''); setError('')
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
      created_by: profile.id, updated_by: profile.id, sort_order: maxOrder,
    }).select('id, title').single()

    setLoading(false)
    if (err) { setError(err.message); return }
    if (assignedTo && assignedTo !== profile.id) {
      await supabase.from('notifications').insert({
        user_id: assignedTo, type: 'task_assigned',
        message: `Byl/a jsi přiřazen/a k úkolu: ${newTask?.title}`,
        task_id: newTask?.id, project_id: projectId,
      })
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
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button type="button" variant="secondary" onClick={onClose}>Zrušit</Button>
          <Button type="submit" variant="primary" loading={loading}>Vytvořit úkol</Button>
        </div>
      </form>
    </Modal>
  )
}

// ── Sortable Task Row ─────────────────────────────────────────

function SortableTaskRow({ task, admin, canEdit, selected, anySelected, onToggleSelect, onOpen, onDragSelectStart, onDragSelectEnter, onStatusChange, onPriorityChange, onDueDateChange }: {
  task: TaskWithRelations; admin: boolean; canEdit: boolean
  selected: boolean; anySelected: boolean
  onToggleSelect: (id: string, shiftKey?: boolean) => void
  onOpen: () => void
  onDragSelectStart: (id: string) => void
  onDragSelectEnter: (id: string) => void
  onStatusChange: (taskId: string, val: TaskStatus) => void
  onPriorityChange: (taskId: string, val: TaskPriority) => void
  onDueDateChange: (taskId: string, val: string | null) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const overdue = isOverdue(task.due_date) && task.status !== 'hotovo'
  const commentCount = task.comments?.[0]?.count ?? 0

  return (
    <tr ref={setNodeRef} style={style}
      onClick={anySelected ? undefined : onOpen}
      onMouseDown={anySelected ? (e: React.MouseEvent) => { if (e.button === 0) { e.preventDefault(); onDragSelectStart(task.id) } } : undefined}
      onMouseEnter={anySelected ? (e: React.MouseEvent) => { if (e.buttons === 1) onDragSelectEnter(task.id) } : undefined}
      className={`group border-b border-gray-50 dark:border-gray-800 last:border-0 cursor-pointer select-none
        ${selected ? 'bg-indigo-50 dark:bg-indigo-900/20' : task.status === 'hotovo' ? 'bg-emerald-50/60 hover:bg-emerald-50 dark:bg-emerald-900/10 dark:hover:bg-emerald-900/20' : overdue ? 'bg-red-50/30 hover:bg-gray-50 dark:bg-red-900/5 dark:hover:bg-gray-800/50' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}
        ${isDragging ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}>
      <td className="pl-1.5 pr-1 py-2.5 w-12"
        onMouseDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onToggleSelect(task.id, e.shiftKey) }}>
        <div className="flex items-center justify-center gap-0.5">
          {admin && !anySelected && (
            <span {...attributes} {...listeners}
              onClick={e => e.stopPropagation()}
              className="flex items-center justify-center cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity select-none">
              <GripVertical size={14} />
            </span>
          )}
          <input type="checkbox" checked={selected} onChange={() => {}}
            className={`w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 cursor-pointer transition-opacity
              ${selected || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className={`text-sm font-medium ${task.status === 'hotovo' ? 'line-through text-emerald-700/60 dark:text-emerald-400/60' : overdue ? 'text-red-700 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>{task.title}</span>
          {commentCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-gray-400 shrink-0 mt-0.5"><MessageSquare size={11} />{commentCount}</span>
          )}
        </div>
        {task.description && <p className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">{task.description}</p>}
      </td>
      <td className="px-3 py-2.5 hidden sm:table-cell">
        {task.task_assignees && task.task_assignees.length > 0 ? (
          <div className="flex -space-x-1.5 items-center">
            {task.task_assignees.slice(0, 3).map(a => a.profiles ? (
              <Avatar key={a.user_id} name={a.profiles.name} initials={a.profiles.initials} color={a.profiles.color} small />
            ) : null)}
            {task.task_assignees.length > 3 && (
              <span className="text-xs text-gray-400 pl-2">+{task.task_assignees.length - 3}</span>
            )}
          </div>
        ) : <span className="text-xs text-gray-400">–</span>}
      </td>
      <td className="px-3 py-2.5">
        {canEdit ? (
          <InlineSelect<TaskStatus>
            value={task.status} options={STATUS_LABELS}
            onChange={val => onStatusChange(task.id, val)}
            renderBadge={() => <StatusBadge status={task.status} />}
          />
        ) : <StatusBadge status={task.status} />}
      </td>
      <td className="px-3 py-2.5 hidden md:table-cell">
        {canEdit ? (
          <InlineSelect<TaskPriority>
            value={task.priority} options={PRIORITY_LABELS}
            onChange={val => onPriorityChange(task.id, val)}
            renderBadge={() => <PriorityBadge priority={task.priority} />}
          />
        ) : <PriorityBadge priority={task.priority} />}
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        {canEdit
          ? <InlineDateInput value={task.due_date} onChange={val => onDueDateChange(task.id, val)} />
          : <span className={`text-sm ${overdue ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>{formatDate(task.due_date)}</span>
        }
      </td>
      <td className="px-3 py-2.5 hidden xl:table-cell">
        {task.file_path && (
          <button onClick={e => { e.stopPropagation(); copyToClipboard(task.file_path!).then(ok => ok && toast.success('Cesta zkopírována!')) }}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1">
            <Copy size={13} />
          </button>
        )}
      </td>
    </tr>
  )
}

// ── Task Group ────────────────────────────────────────────────

function TaskGroup({ group, admin, profile, selectedTaskIds, onToggleSelect, onToggleGroup, onOpenTask, onCreateTask, onDragSelectStart, onDragSelectEnter, onStatusChange, onPriorityChange, onDueDateChange, onDragEnd }: {
  group: { id: string | null; name: string; tasks: TaskWithRelations[] }
  admin: boolean; profile: { id: string } | null
  selectedTaskIds: Set<string>
  onToggleSelect: (id: string, shiftKey?: boolean) => void
  onToggleGroup: (ids: string[]) => void
  onOpenTask: (task: TaskWithRelations) => void
  onCreateTask: (subprojectId: string) => void
  onDragSelectStart: (id: string) => void
  onDragSelectEnter: (id: string) => void
  onStatusChange: (taskId: string, val: TaskStatus) => void
  onPriorityChange: (taskId: string, val: TaskPriority) => void
  onDueDateChange: (taskId: string, val: string | null) => void
  onDragEnd: (subprojectId: string | null, activeId: string, overId: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const total = group.tasks.length
  const done  = group.tasks.filter(t => t.status === 'hotovo').length
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0
  const anySelected = selectedTaskIds.size > 0
  const allGroupSelected = total > 0 && group.tasks.every(t => selectedTaskIds.has(t.id))
  const someGroupSelected = !allGroupSelected && group.tasks.some(t => selectedTaskIds.has(t.id))

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    onDragEnd(group.id, String(active.id), String(over.id))
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden mb-4">
      {/* Group header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 cursor-pointer select-none hover:bg-gray-50 dark:hover:bg-gray-800/50"
        onClick={() => setCollapsed(c => !c)}>
        <div className="w-4 h-4 flex items-center justify-center shrink-0" onClick={e => { e.stopPropagation(); onToggleGroup(group.tasks.map(t => t.id)) }}>
          <input type="checkbox" checked={allGroupSelected} ref={el => { if (el) el.indeterminate = someGroupSelected }}
            onChange={() => onToggleGroup(group.tasks.map(t => t.id))}
            onClick={e => e.stopPropagation()}
            className={`w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 cursor-pointer transition-opacity ${anySelected || allGroupSelected || someGroupSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
        </div>
        <span className="text-gray-400">{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</span>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex-1">{group.name}</h3>
        <span className="text-xs text-gray-400">{total} úkol{total === 1 ? '' : total < 5 ? 'y' : 'ů'}</span>
        {total > 0 && (
          <>
            <div className="w-16 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
          </>
        )}
        {!collapsed && (
          <button onClick={e => { e.stopPropagation(); onCreateTask(group.id ?? '') }}
            className="ml-2 p-1 rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 dark:hover:text-indigo-400"
            title="Přidat úkol">
            <Plus size={15} />
          </button>
        )}
      </div>

      {!collapsed && (
        total === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            Žádné úkoly v této skupině.
            <button onClick={() => onCreateTask(group.id ?? '')} className="ml-2 text-indigo-600 dark:text-indigo-400 hover:underline">+ Přidat úkol</button>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={group.tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="border-b border-gray-50 dark:border-gray-800 text-xs text-gray-400 uppercase tracking-wide">
                    <th className="w-12 pl-1.5 shrink-0" />
                    <th className="text-left px-3 py-2 font-medium">Úkol</th>
                    <th className="text-left px-3 py-2 font-medium hidden sm:table-cell w-36">Přiřazený</th>
                    <th className="text-left px-3 py-2 font-medium w-36">Stav</th>
                    <th className="text-left px-3 py-2 font-medium hidden md:table-cell w-28">Priorita</th>
                    <th className="text-left px-3 py-2 font-medium hidden lg:table-cell w-32">Termín</th>
                    <th className="w-8 hidden xl:table-cell" />
                  </tr>
                </thead>
                <tbody>
                  {group.tasks.map(task => (
                    <SortableTaskRow key={task.id} task={task}
                      admin={admin}
                      canEdit={admin || task.assigned_to === profile?.id}
                      selected={selectedTaskIds.has(task.id)}
                      anySelected={anySelected}
                      onToggleSelect={onToggleSelect}
                      onOpen={() => onOpenTask(task)}
                      onDragSelectStart={onDragSelectStart}
                      onDragSelectEnter={onDragSelectEnter}
                      onStatusChange={onStatusChange}
                      onPriorityChange={onPriorityChange}
                      onDueDateChange={onDueDateChange}
                    />
                  ))}
                </tbody>
              </table>
            </SortableContext>
          </DndContext>
        )
      )}
    </div>
  )
}

// ── Manage Subprojects Modal ──────────────────────────────────

let _subRowKey = 0

interface SubRow {
  key: number
  origId: string | null
  name: string
  sort_order: number
  deleted: boolean
}

function ManageSubprojectsModal({ open, onClose, projectId, subprojects, onSaved }: {
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
        {/* Existing / working list */}
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

        {/* Add from 3DMax */}
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

        {/* Add from templates */}
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

        {/* Add custom */}
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

// ── Project Page ──────────────────────────────────────────────

export function ProjectPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate      = useNavigate()
  const { profile, isAdmin } = useAuthStore()
  const queryClient   = useQueryClient()
  const admin = isAdmin()
  const confirm = useConfirm()

  const [filterUser,      setFilterUser]      = useState('')
  const [filterStatus,    setFilterStatus]    = useState('')
  const [filterPriority,  setFilterPriority]  = useState('')
  const [filterSubproject,setFilterSubproject]= useState('')
  const [search,          setSearch]          = useState('')
  const [selectedTask,    setSelectedTask]    = useState<TaskWithRelations | null>(null)
  const [showCreate,      setShowCreate]      = useState(false)
  const [createSubId,     setCreateSubId]     = useState('')
  const [showEditProject,       setShowEditProject]       = useState(false)
  const [showManageSubprojects, setShowManageSubprojects] = useState(false)
  const [selectedTaskIds,   setSelectedTaskIds]   = useState<Set<string>>(new Set())
  const [showTemplatesModal, setShowTemplatesModal] = useState(false)
  const [showBulkCreate,    setShowBulkCreate]    = useState(false)
  const [showAdminMenu,     setShowAdminMenu]     = useState(false)
  const lastSelectedId    = useRef<string | null>(null)
  const adminMenuRef      = useRef<HTMLDivElement>(null)
  const isDragSelectActive = useRef(false)
  const isDragSelectAdd    = useRef(true)

  useEffect(() => {
    if (!showAdminMenu) return
    function handler(e: MouseEvent) {
      if (adminMenuRef.current && !adminMenuRef.current.contains(e.target as Node)) setShowAdminMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAdminMenu])

  useEffect(() => {
    function stop() { isDragSelectActive.current = false }
    document.addEventListener('mouseup', stop)
    return () => document.removeEventListener('mouseup', stop)
  }, [])

  // ── Data queries ───────────────────────────────────────────

  const { data: project } = useQuery<(Project & { project_members: { user_id: string; profiles: Profile }[] }) | null>({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const { data } = await supabase.from('projects')
        .select('*, project_members(user_id, profiles(id, name, role, initials, color))')
        .eq('id', projectId!).single()
      return data as (Project & { project_members: { user_id: string; profiles: Profile }[] }) | null
    },
    enabled: !!projectId,
  })

  const members = useMemo((): Profile[] =>
    (project?.project_members || []).map(m => m.profiles).filter(Boolean) as Profile[],
    [project])

  const { data: subprojects = [] } = useQuery<Subproject[]>({
    queryKey: ['subprojects', projectId],
    queryFn: async () => {
      const { data } = await supabase.from('subprojects').select('*').eq('project_id', projectId!).order('sort_order')
      return (data || []) as Subproject[]
    },
    enabled: !!projectId,
  })

  const { data: tasks = [] } = useQuery<TaskWithRelations[]>({
    queryKey: ['tasks', projectId],
    queryFn: async () => {
      let q = supabase.from('tasks')
        .select('*, comments(count), assigned:assigned_to(id, name, initials, color), creator:created_by(id, name), updater:updated_by(id, name), task_assignees(user_id, profiles(id, name, initials, color))')
        .eq('project_id', projectId!)
        .order('sort_order', { ascending: true })
      const { data } = await q
      return (data || []) as TaskWithRelations[]
    },
    enabled: !!projectId,
  })

  // ── Realtime ───────────────────────────────────────────────

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
    queryClient.invalidateQueries({ queryKey: ['subprojects', projectId] })
  }, [queryClient, projectId])

  useEffect(() => {
    const ch = supabase.channel(`project-${projectId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${projectId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_members' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'subprojects', filter: `project_id=eq.${projectId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignees' }, invalidate)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [projectId, invalidate])

  // ── Filtering ──────────────────────────────────────────────

  const filteredTasks = useMemo(() => {
    let result = tasks
    if (filterUser)       result = result.filter(t => t.assigned_to === filterUser || t.task_assignees?.some(a => a.user_id === filterUser))
    if (filterStatus)     result = result.filter(t => t.status === filterStatus)
    if (filterPriority)   result = result.filter(t => t.priority === filterPriority)
    if (filterSubproject === '__none__') result = result.filter(t => !t.subproject_id)
    else if (filterSubproject) result = result.filter(t => t.subproject_id === filterSubproject)
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(t => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
    }
    return result
  }, [tasks, filterUser, filterStatus, filterPriority, filterSubproject, search])

  const groups = useMemo(() => {
    const result: { id: string | null; name: string; tasks: TaskWithRelations[] }[] = subprojects.map(sp => ({
      id: sp.id,
      name: sp.name,
      tasks: filteredTasks.filter(t => t.subproject_id === sp.id),
    }))
    const orphans = filteredTasks.filter(t => !t.subproject_id)
    if (orphans.length > 0 || subprojects.length === 0) {
      result.push({ id: null, name: 'Bez podprojektu', tasks: orphans })
    }
    return result
  }, [subprojects, filteredTasks])

  const allTasksInOrder = useMemo(() => groups.flatMap(g => g.tasks), [groups])

  // ── Inline status/priority update ─────────────────────────

  async function handleStatusChange(taskId: string, val: TaskStatus) {
    if (!profile) return
    const old = tasks.find(t => t.id === taskId)
    await supabase.from('tasks').update({ status: val, updated_by: profile.id }).eq('id', taskId)
    if (old) await supabase.from('task_activity').insert({ task_id: taskId, user_id: profile.id, field: 'status', old_value: old.status, new_value: val })
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handlePriorityChange(taskId: string, val: TaskPriority) {
    if (!profile) return
    await supabase.from('tasks').update({ priority: val, updated_by: profile.id }).eq('id', taskId)
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handleDueDateChange(taskId: string, val: string | null) {
    if (!profile) return
    await supabase.from('tasks').update({ due_date: val, updated_by: profile.id }).eq('id', taskId)
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  // ── Drag & drop ────────────────────────────────────────────

  async function handleDragEnd(subprojectId: string | null, activeId: string, overId: string) {
    const subTasks = tasks.filter(t => t.subproject_id === subprojectId || (!t.subproject_id && subprojectId === null))
    const oldIndex = subTasks.findIndex(t => t.id === activeId)
    const newIndex = subTasks.findIndex(t => t.id === overId)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(subTasks, oldIndex, newIndex)
    const updates = reordered.map((t, i) => supabase.from('tasks').update({ sort_order: (i + 1) * 10 }).eq('id', t.id))
    await Promise.all(updates)
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  // ── Bulk actions ──────────────────────────────────────────

  function toggleTaskSelection(id: string, shiftKey = false) {
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (shiftKey && lastSelectedId.current && lastSelectedId.current !== id) {
        const fromIdx = allTasksInOrder.findIndex(t => t.id === lastSelectedId.current)
        const toIdx = allTasksInOrder.findIndex(t => t.id === id)
        if (fromIdx !== -1 && toIdx !== -1) {
          const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
          for (let i = lo; i <= hi; i++) next.add(allTasksInOrder[i].id)
        } else {
          next.has(id) ? next.delete(id) : next.add(id)
        }
      } else {
        next.has(id) ? next.delete(id) : next.add(id)
      }
      return next
    })
    lastSelectedId.current = id
  }

  function toggleGroupSelection(ids: string[]) {
    setSelectedTaskIds(prev => {
      const allIn = ids.every(id => prev.has(id))
      const next = new Set(prev)
      allIn ? ids.forEach(id => next.delete(id)) : ids.forEach(id => next.add(id))
      return next
    })
  }

  function handleDragSelectStart(id: string) {
    isDragSelectActive.current = true
    setSelectedTaskIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) { isDragSelectAdd.current = false; n.delete(id) }
      else            { isDragSelectAdd.current = true;  n.add(id)    }
      return n
    })
  }

  function handleDragSelectEnter(id: string) {
    if (!isDragSelectActive.current) return
    setSelectedTaskIds(prev => {
      if (isDragSelectAdd.current) {
        if (prev.has(id)) return prev
        const n = new Set(prev); n.add(id); return n
      } else {
        if (!prev.has(id)) return prev
        const n = new Set(prev); n.delete(id); return n
      }
    })
  }

  async function handleBulkStatus(status: TaskStatus) {
    await supabase.from('tasks').update({ status, updated_by: profile!.id }).in('id', Array.from(selectedTaskIds))
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handleBulkPriority(priority: TaskPriority) {
    await supabase.from('tasks').update({ priority, updated_by: profile!.id }).in('id', Array.from(selectedTaskIds))
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handleBulkAssign(userId: string) {
    const taskIds = Array.from(selectedTaskIds)
    const assigned_to = userId === '__unassign__' ? null : userId
    await supabase.from('tasks').update({ assigned_to, updated_by: profile!.id }).in('id', taskIds)
    await supabase.from('task_assignees').delete().in('task_id', taskIds)
    if (assigned_to) {
      await supabase.from('task_assignees').insert(taskIds.map(id => ({ task_id: id, user_id: assigned_to })))
    }
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handleBulkDelete() {
    const count = selectedTaskIds.size
    if (!await confirm({
      title: 'Smazat úkoly',
      message: `Opravdu smazat ${count} vybraných úkolů? Tato akce je nevratná.`,
      confirmLabel: 'Smazat',
      variant: 'danger',
    })) return
    await supabase.from('tasks').delete().in('id', Array.from(selectedTaskIds))
    setSelectedTaskIds(new Set())
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
    toast.success(`${count} úkolů smazáno.`)
  }

  // ── Project actions ────────────────────────────────────────

  async function handleToggleStatus() {
    if (!project) return
    const isDone = project.status === 'dokončeno'
    if (!await confirm({
      message: isDone ? 'Znovu otevřít projekt?' : 'Opravdu dokončit projekt?',
      confirmLabel: isDone ? 'Otevřít' : 'Dokončit',
    })) return
    await supabase.from('projects').update({ status: isDone ? 'aktivní' : 'dokončeno' }).eq('id', projectId!)
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
    toast.success(isDone ? 'Projekt znovu otevřen.' : 'Projekt dokončen.')
  }

  async function handleDeleteProject() {
    if (!await confirm({
      title: 'Smazat projekt',
      message: `Opravdu smazat celý projekt „${project?.name}" včetně všech úkolů? Tato akce je nevratná.`,
      confirmLabel: 'Smazat projekt',
      variant: 'danger',
    })) return
    await supabase.from('projects').delete().eq('id', projectId!)
    toast.success('Projekt smazán.')
    navigate('/dashboard')
  }

  if (!project) {
    return (
      <PageLayout onManageTemplates={admin ? () => setShowTemplatesModal(true) : undefined}>
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </PageLayout>
    )
  }

  const isDone  = project.status === 'dokončeno'
  const overdue = isOverdue(project.due_date) && !isDone

  const hasFilters = filterUser || filterStatus || filterPriority || filterSubproject || search

  return (
    <PageLayout>
      {/* Project header */}
      <div className="mb-6 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{project.name}</h1>
            {project.description && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{project.description}</p>}
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {isDone && <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Dokončeno</span>}
              {project.due_date && (
                <span className={`text-sm ${overdue ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                  Termín: {formatDate(project.due_date)}
                </span>
              )}
              {project.file_path && (
                <button
                  onClick={() => copyToClipboard(project.file_path!).then(ok => ok && toast.success('Cesta zkopírována!'))}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  <Copy size={12} /> {project.file_path}
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex -space-x-1">
              {members.map(m => <Avatar key={m.id} name={m.name} initials={m.initials} color={m.color} small />)}
            </div>
            {!isDone && (
              <>
                <Button size="sm" variant="primary" onClick={() => { setCreateSubId(''); setShowCreate(true) }}>
                  <Plus size={14} /> Přidat úkol
                </Button>
                {admin && (
                  <Button size="sm" variant="secondary" onClick={() => setShowBulkCreate(true)}>
                    <Plus size={14} /> Hromadně
                  </Button>
                )}
              </>
            )}
            {admin && (
              <div className="relative" ref={adminMenuRef}>
                <button
                  onClick={() => setShowAdminMenu(m => !m)}
                  className={`flex items-center justify-center w-8 h-8 rounded-md border text-sm transition-colors
                    ${showAdminMenu
                      ? 'border-gray-400 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:border-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                >
                  <MoreHorizontal size={16} />
                </button>
                {showAdminMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-30 min-w-[190px] overflow-hidden py-1">
                    <button onClick={() => { setShowEditProject(true); setShowAdminMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2.5">
                      <Settings size={14} className="shrink-0" /> Upravit projekt
                    </button>
                    <button onClick={() => { setShowManageSubprojects(true); setShowAdminMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2.5">
                      <ChevronRight size={14} className="shrink-0" /> Podprojekty
                    </button>
                    <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
                    <button onClick={() => { handleToggleStatus(); setShowAdminMenu(false) }}
                      className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2.5 ${isDone ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800' : 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'}`}>
                      <CheckCircle size={14} className="shrink-0" /> {isDone ? 'Znovu otevřít' : 'Dokončit projekt'}
                    </button>
                    <button onClick={() => { handleDeleteProject(); setShowAdminMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2.5">
                      <Trash2 size={14} className="shrink-0" /> Smazat projekt
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input type="text" placeholder="Hledat úkoly…" value={search} onChange={e => setSearch(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-40" />
        <select value={filterUser} onChange={e => setFilterUser(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">Všichni</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">Všechny stavy</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">Všechny priority</option>
          {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {subprojects.length > 0 && (
          <select value={filterSubproject} onChange={e => setFilterSubproject(e.target.value)}
            className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">Všechny podprojekty</option>
            {subprojects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__none__">Bez podprojektu</option>
          </select>
        )}
        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={() => { setFilterUser(''); setFilterStatus(''); setFilterPriority(''); setFilterSubproject(''); setSearch('') }}>
            Zrušit filtry
          </Button>
        )}
      </div>

      {/* Task groups */}
      {groups.map(group => (
        <TaskGroup key={group.id ?? '__none__'} group={group}
          admin={admin} profile={profile}
          selectedTaskIds={selectedTaskIds}
          onToggleSelect={toggleTaskSelection}
          onToggleGroup={toggleGroupSelection}
          onOpenTask={setSelectedTask}
          onCreateTask={subId => { setCreateSubId(subId); setShowCreate(true) }}
          onDragSelectStart={handleDragSelectStart}
          onDragSelectEnter={handleDragSelectEnter}
          onStatusChange={handleStatusChange}
          onPriorityChange={handlePriorityChange}
          onDueDateChange={handleDueDateChange}
          onDragEnd={handleDragEnd}
        />
      ))}

      {/* Bulk action bar — rendered via portal to escape page-enter transform stacking context */}
      {selectedTaskIds.size > 0 && createPortal(
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl px-4 py-2.5">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300 mr-1 shrink-0">{selectedTaskIds.size} vybráno</span>
          <div className="w-px h-5 bg-gray-200 dark:bg-gray-600 mx-1" />
          <select defaultValue="" onChange={e => { if (e.target.value) { handleBulkStatus(e.target.value as TaskStatus); e.currentTarget.value = '' } }}
            className="px-2 py-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-700 dark:text-gray-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="" disabled>Stav…</option>
            {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select defaultValue="" onChange={e => { if (e.target.value) { handleBulkPriority(e.target.value as TaskPriority); e.currentTarget.value = '' } }}
            className="px-2 py-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-700 dark:text-gray-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="" disabled>Priorita…</option>
            {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select defaultValue="" onChange={e => { if (e.target.value) { handleBulkAssign(e.target.value); e.currentTarget.value = '' } }}
            className="px-2 py-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-700 dark:text-gray-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="" disabled>Přiřadit…</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            <option value="__unassign__">— Zrušit přiřazení</option>
          </select>
          <div className="w-px h-5 bg-gray-200 dark:bg-gray-600 mx-1" />
          <Button variant="danger" size="sm" onClick={handleBulkDelete}>Smazat</Button>
          <button onClick={() => setSelectedTaskIds(new Set())} className="ml-1 p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <X size={15} />
          </button>
        </div>,
        document.body
      )}

      {/* Modals */}
      <TaskDetailModal
        task={selectedTask}
        subprojects={subprojects}
        members={members}
        projectId={projectId!}
        onClose={() => setSelectedTask(null)}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })}
      />

      <CreateTaskModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        projectId={projectId!}
        subprojects={subprojects}
        members={members}
        defaultSubprojectId={createSubId}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })}
      />

      <ManageSubprojectsModal
        open={showManageSubprojects}
        onClose={() => setShowManageSubprojects(false)}
        projectId={projectId!}
        subprojects={subprojects}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['subprojects', projectId] })}
      />

      <ManageTaskTemplatesModal open={showTemplatesModal} onClose={() => setShowTemplatesModal(false)} />

      <BulkCreateTasksModal
        open={showBulkCreate}
        onClose={() => setShowBulkCreate(false)}
        projectId={projectId!}
        subprojects={subprojects}
        members={members}
        tasks={tasks}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })}
      />

      {showEditProject && project && (
        <EditProjectModal
          project={project as Project}
          members={members}
          allProfiles={members}
          onClose={() => setShowEditProject(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['project', projectId] })
            setShowEditProject(false)
          }}
        />
      )}
    </PageLayout>
  )
}

// ── Edit Project Modal ────────────────────────────────────────

function EditProjectModal({ project, allProfiles, onClose, onSaved }: {
  project: Project; members: Profile[]; allProfiles: Profile[]
  onClose: () => void; onSaved: () => void
}) {
  const [name,      setName]      = useState(project.name)
  const [desc,      setDesc]      = useState(project.description ?? '')
  const [dueDate,   setDueDate]   = useState(project.due_date ?? '')
  const [filePath,  setFilePath]  = useState(project.file_path ?? '')
  const [memberIds, setMemberIds] = useState<string[]>(allProfiles.map(m => m.id))
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('*').order('name')
      return (data || []) as Profile[]
    },
  })

  async function handleSave() {
    if (!name.trim()) { setError('Název nesmí být prázdný.'); return }
    setLoading(true); setError('')
    const { error: projErr } = await supabase.from('projects').update({
      name: name.trim(), description: desc.trim() || null, due_date: dueDate || null,
      file_path: filePath.trim() || null,
    }).eq('id', project.id)
    if (projErr) { setError(projErr.message); setLoading(false); return }

    await supabase.from('project_members').delete().eq('project_id', project.id)
    if (memberIds.length > 0) {
      await supabase.from('project_members').insert(memberIds.map(uid => ({ project_id: project.id, user_id: uid })))
    }
    toast.success('Projekt uložen.')
    onSaved()
  }

  return (
    <Modal open title="Upravit projekt" onClose={onClose} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Název *</label>
          <input value={name} onChange={e => setName(e.target.value)} required className={inputClass} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Popis</label>
          <textarea rows={2} value={desc} onChange={e => setDesc(e.target.value)} className={`${inputClass} resize-none`} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Termín</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cesta k souboru</label>
            <input value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="\\server\share" className={inputClass} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Členové</label>
          <div className="flex flex-wrap gap-2">
            {profiles.map(p => {
              const checked = memberIds.includes(p.id)
              return (
                <label key={p.id} className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border cursor-pointer ${checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-600 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                  <input type="checkbox" className="sr-only" checked={checked} onChange={() => setMemberIds(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id])} />
                  <Avatar name={p.name} initials={p.initials} color={p.color} small />
                  {p.name}
                </label>
              )
            })}
          </div>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button variant="secondary" onClick={onClose}>Zrušit</Button>
          <Button variant="primary" loading={loading} onClick={handleSave}>Uložit změny</Button>
        </div>
      </div>
    </Modal>
  )
}

// ── Bulk Create Tasks Modal ───────────────────────────────────

function BulkCreateTasksModal({ open, onClose, projectId, subprojects, members, tasks, onCreated }: {
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
                    {t.subproject && <span className="text-xs text-gray-400 shrink-0">{t.subproject.name}</span>}
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
