import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Copy, Send, Trash2, Paperclip, CheckCircle, MapPin, ExternalLink, FileText, Download } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useSignedUrl } from '@/lib/storage'
import { useAuthStore } from '@/stores/authStore'
import { Avatar } from '@/components/ui/Avatar'
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { formatDate, formatDateTime, isOverdue, STATUS_LABELS, PRIORITY_LABELS, copyToClipboard } from '@/lib/utils'
import type { TaskWithRelations, Subproject, Profile, Comment, TaskAttachment, TaskStatus, TaskPriority } from '@/lib/types'
import { inputClass, formatFileSize, isImageUrl } from './shared'

/** Obrázek z privátního bucketu `attachments` — podepíše cestu/URL za běhu (i staré public URL). */
function AttImg({ value, className, onClick }: { value: string; className?: string; onClick?: (src: string) => void }) {
  const src = useSignedUrl('attachments', value)
  if (!src) return <div className={className} style={{ background: 'rgba(0,0,0,0.06)' }} />
  return <img src={src} alt="" className={className} onClick={onClick ? () => onClick(src) : undefined} />
}

function AttachmentCard({ att, canEdit, onLightbox, onDelete }: {
  att: TaskAttachment; canEdit: boolean
  onLightbox: (src: string) => void
  onDelete: (id: string, path: string) => void
}) {
  const url = useSignedUrl('attachments', att.file_path)
  const isImg = /\.(jpe?g|png|gif|webp|svg)$/i.test(att.name) || att.mime_type?.startsWith('image/')
  return (
    <div className="group relative rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-800 flex flex-col">
      {isImg && url ? (
        <div className="h-24 bg-gray-100 dark:bg-gray-700 overflow-hidden cursor-zoom-in" onClick={() => onLightbox(url)}>
          <img src={url} alt={att.name} className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="h-24 flex items-center justify-center bg-gray-100 dark:bg-gray-800">
          <FileText size={32} className="text-gray-300 dark:text-gray-600" />
        </div>
      )}
      <div className="px-2 py-1.5 flex items-center gap-1.5 min-w-0">
        <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1" title={att.name}>{att.name}</span>
        {url && (
          <a href={url} download={att.name} target="_blank" rel="noreferrer"
            className="shrink-0 p-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors" title="Stáhnout">
            <Download size={12} />
          </a>
        )}
        {canEdit && (
          <button onClick={() => onDelete(att.id, att.file_path)}
            className="shrink-0 p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors" title="Smazat">
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {att.file_size && (
        <span className="absolute top-1.5 right-1.5 text-[10px] bg-black/50 text-white rounded px-1 py-0.5 leading-none">{formatFileSize(att.file_size)}</span>
      )}
    </div>
  )
}

function CommentText({ text, onImageClick }: { text: string; onImageClick?: (src: string) => void }) {
  return (
    <>
      {text.split('\n').map((line, i, arr) =>
        isImageUrl(line.trim())
          ? <AttImg key={i} value={line.trim()}
              className="max-w-full max-h-64 rounded-lg mt-1 block cursor-zoom-in"
              onClick={onImageClick}
            />
          : <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
      )}
    </>
  )
}

export function TaskDetailModal({ task, subprojects, members, projectId, onClose, onSaved }: {
  task: TaskWithRelations | null
  subprojects: Subproject[]
  members: Profile[]
  projectId: string
  onClose: () => void
  onSaved: () => void
}) {
  const { profile, isAdmin } = useAuthStore()
  const admin      = isAdmin()
  const isCreator  = task?.created_by === profile?.id
  const canFullEdit = admin || isCreator
  const canDelete   = admin || isCreator
  const confirm = useConfirm()

  const [title,          setTitle]          = useState('')
  const [status,         setStatus]         = useState<TaskStatus>('neudělano')
  const [priority,       setPriority]       = useState<TaskPriority>('medium')
  const [dueDate,        setDueDate]        = useState('')
  const [desc,           setDesc]           = useState('')
  const [subprojectId,   setSubprojectId]   = useState<string>('')
  const [assignedToIds,  setAssignedToIds]  = useState<string[]>([])
  const [filePath,       setFilePath]       = useState('')
  const [annotationId,   setAnnotationId]   = useState<string | null>(null)
  const [annModelId,     setAnnModelId]     = useState('')
  const [annPickerOpen,  setAnnPickerOpen]  = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [comment,        setComment]        = useState('')
  const [attachedImages, setAttachedImages] = useState<string[]>([])
  const [sending,        setSending]        = useState(false)
  const [error,       setError]       = useState('')
  const [activeTab,   setActiveTab]   = useState<'comments' | 'attachments' | 'history'>('comments')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isAssigned = task?.assigned_to === profile?.id
    || task?.task_assignees?.some(a => a.user_id === profile?.id)
    || (profile ? assignedToIds.includes(profile.id) : false)
  const canChangeStatus = admin || isCreator || isAssigned

  useEffect(() => {
    if (!lightboxSrc) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxSrc(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxSrc])

  const MAX_FILE_SIZE = 25 * 1024 * 1024

  async function uploadImage(file: File): Promise<string | null> {
    if (file.size > MAX_FILE_SIZE) { toast.error('Obrázek je příliš velký (max 25 MB)'); return null }
    const ext = file.name.split('.').pop() || 'png'
    const path = `comment-images/${task?.id}/${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage.from('attachments').upload(path, file)
    if (upErr) { toast.error('Nepodařilo se nahrát obrázek'); return null }
    return path // ukládáme cestu; renderuje se přes signed URL
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
      setFilePath(task.file_path ?? '')
      setAnnotationId(task.annotation_id ?? null)
      setAnnModelId(task.annotation?.model_id ?? task.linked_model?.id ?? '')
      setAnnPickerOpen(false)
      setError(''); setComment(''); setAttachedImages([])
    }
  }, [task])

  const attachFileRef = useRef<HTMLInputElement>(null)

  const { data: attachments = [], refetch: refetchAttachments } = useQuery<TaskAttachment[]>({
    queryKey: ['task-attachments', task?.id],
    queryFn: async () => {
      const { data } = await supabase.from('task_attachments').select('*').eq('task_id', task!.id).order('created_at')
      return (data || []) as TaskAttachment[]
    },
    enabled: !!task,
  })

  async function handleAddAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    if (!files.length || !task || !profile) return
    e.target.value = ''
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) { toast.error(`${file.name} je příliš velký (max 25 MB)`); continue }
      const path = `task-files/${task.id}/${Date.now()}_${file.name}`
      const { error: upErr } = await supabase.storage.from('attachments').upload(path, file)
      if (upErr) { toast.error(`Nepodařilo se nahrát ${file.name}`); continue }
      await supabase.from('task_attachments').insert({ task_id: task.id, name: file.name, file_path: path, mime_type: file.type || null, file_size: file.size, created_by: profile.id })
    }
    refetchAttachments()
  }

  async function handleDeleteAttachment(id: string, filePath: string) {
    await supabase.storage.from('attachments').remove([filePath])
    await supabase.from('task_attachments').delete().eq('id', id)
    refetchAttachments()
  }

  const { data: comments = [], refetch: refetchComments } = useQuery<Comment[]>({
    queryKey: ['task-comments', task?.id],
    queryFn: async () => {
      const { data } = await supabase.from('comments').select('*, author:author_id(id, name)')
        .eq('task_id', task!.id).order('created_at', { ascending: true })
      return (data || []) as Comment[]
    },
    enabled: !!task,
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

  const queryClient = useQueryClient()

  async function handleImmediateSelfAssign() {
    if (!task || !profile) return
    const isSelf = task.task_assignees?.some(a => a.user_id === profile.id) || assignedToIds.includes(profile.id)
    if (isSelf) {
      const { error } = await supabase.from('task_assignees').delete().eq('task_id', task.id).eq('user_id', profile.id)
      if (error) { toast.error('Nepodařilo se odebrat přiřazení: ' + error.message); return }
      setAssignedToIds(prev => prev.filter(id => id !== profile.id))
    } else {
      const { error } = await supabase.from('task_assignees').upsert({ task_id: task.id, user_id: profile.id }, { onConflict: 'task_id,user_id' })
      if (error) { toast.error('Nepodařilo se přiřadit: ' + error.message); return }
      setAssignedToIds(prev => [...prev, profile.id])
    }
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
    onSaved()
  }

  const { data: history = [], refetch: refetchHistory } = useQuery({
    queryKey: ['task-history', task?.id],
    queryFn: async () => {
      const { data } = await supabase.from('task_activity')
        .select('*, user:user_id(id, name)').eq('task_id', task!.id)
        .order('created_at', { ascending: false }).limit(100)
      return data || []
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
    const updateData = canFullEdit ? {
      title: title.trim() || task.title,
      status, priority, due_date: dueDate || null, description: desc || null,
      subproject_id: subprojectId || null, file_path: filePath.trim() || null,
      model_id: annModelId || null,
      annotation_id: annotationId || null,
      updated_by: profile.id,
      ...(canFullEdit ? { assigned_to: assignedToIds[0] || null } : {}),
    } : {
      status,
      updated_by: profile.id,
    }
    if (canFullEdit && !title.trim()) { setError('Název úkolu nesmí být prázdný.'); setSaving(false); return }
    const { error: err } = await supabase.from('tasks').update(updateData).eq('id', task.id)
    if (err) { setError(err.message); setSaving(false); return }

    type ActivityEntry = { field: string; old_value: string | null; new_value: string | null }
    const entries: ActivityEntry[] = []

    if (title.trim() !== task.title)
      entries.push({ field: 'název', old_value: task.title, new_value: title.trim() })
    if (status !== task.status)
      entries.push({ field: 'stav', old_value: STATUS_LABELS[task.status], new_value: STATUS_LABELS[status] })
    if (priority !== task.priority)
      entries.push({ field: 'priorita', old_value: PRIORITY_LABELS[task.priority], new_value: PRIORITY_LABELS[priority] })
    if ((dueDate || null) !== task.due_date)
      entries.push({ field: 'termín', old_value: formatDate(task.due_date), new_value: formatDate(dueDate || null) })
    if ((desc.trim() || null) !== (task.description || null))
      entries.push({ field: 'popis', old_value: task.description ? '(text)' : null, new_value: desc.trim() ? '(text)' : null })
    const prevSubId = task.subproject_id ?? null
    const newSubId  = subprojectId || null
    if (prevSubId !== newSubId)
      entries.push({ field: 'podprojekt', old_value: subprojects.find(s => s.id === prevSubId)?.name ?? 'Bez podprojektu', new_value: subprojects.find(s => s.id === newSubId)?.name ?? 'Bez podprojektu' })
    if ((annotationId || null) !== (task.annotation_id || null))
      entries.push({ field: 'anotace', old_value: task.annotation?.text ?? null, new_value: annotationId ? (pickerAnnotations.find(a => a.id === annotationId)?.text ?? task.annotation?.text ?? null) : null })

    if (canFullEdit) {
      const prevIds = task.task_assignees?.map(a => a.user_id) ?? (task.assigned_to ? [task.assigned_to] : [])
      const addedIds = assignedToIds.filter(id => !prevIds.includes(id))
      const removedIds = prevIds.filter(id => !assignedToIds.includes(id))
      if (addedIds.length > 0 || removedIds.length > 0) {
        entries.push({
          field: 'přiřazení',
          old_value: prevIds.map(id => members.find(m => m.id === id)?.name ?? '?').join(', ') || null,
          new_value: assignedToIds.map(id => members.find(m => m.id === id)?.name ?? '?').join(', ') || null,
        })
      }
      await supabase.from('task_assignees').delete().eq('task_id', task.id)
      if (assignedToIds.length > 0) {
        await supabase.from('task_assignees').insert(assignedToIds.map(uid => ({ task_id: task.id, user_id: uid })))
      }
      for (const uid of addedIds) {
        await supabase.from('notifications').insert({
          user_id: uid, type: 'task_assigned',
          message: `Byl/a jsi přiřazen/a k úkolu: ${task.title}`,
          task_id: task.id, project_id: projectId,
        })
      }
    } else if (profile) {
      const prevIds = task.task_assignees?.map(a => a.user_id) ?? (task.assigned_to ? [task.assigned_to] : [])
      const wasSelf = prevIds.includes(profile.id)
      const isSelf  = assignedToIds.includes(profile.id)
      if (wasSelf !== isSelf) {
        if (isSelf) {
          await supabase.from('task_assignees').insert({ task_id: task.id, user_id: profile.id })
        } else {
          await supabase.from('task_assignees').delete().eq('task_id', task.id).eq('user_id', profile.id)
        }
      }
    }

    if (entries.length > 0) {
      await supabase.from('task_activity').insert(entries.map(e => ({ task_id: task.id, user_id: profile.id, ...e })))
      refetchHistory()
      queryClient.invalidateQueries({ queryKey: ['task-history', task.id] })
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
  const overdue = isOverdue(task.due_date) && task.status !== 'hotovo' && task.status !== 'schváleno'

  return (
    <>
    <Modal open={!!task} onClose={onClose} title={task.title} size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Název */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Název úkolu</label>
            {canFullEdit
              ? <input type="text" value={title} onChange={e => setTitle(e.target.value)} className={inputClass} />
              : <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{task.title}</p>
            }
          </div>

          {/* Popis */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Popis</label>
            {canFullEdit ? (
              <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)} className={`${inputClass} resize-none`} />
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300">{task.description || '–'}</p>
            )}
          </div>

          {/* Podprojekt */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Podprojekt</label>
            {canFullEdit ? (
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
            {canFullEdit ? (
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
              <div className="flex flex-wrap items-center gap-2">
                {task.task_assignees && task.task_assignees.length > 0
                  ? task.task_assignees.map(a => a.profiles ? (
                      <div key={a.user_id} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                        <Avatar name={a.profiles.name} initials={a.profiles.initials} color={a.profiles.color} small />
                        {a.profiles.name}
                      </div>
                    ) : null)
                  : null
                }
                {profile && (() => {
                  const isSelf = task.task_assignees?.some(a => a.user_id === profile.id)
                  return (
                    <button type="button"
                      onClick={handleImmediateSelfAssign}
                      className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full border transition-colors
                        ${isSelf ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-600 dark:text-indigo-300' : 'border-dashed border-gray-300 dark:border-gray-600 text-gray-400 hover:border-indigo-400 hover:text-indigo-500'}`}>
                      {isSelf ? '✓ Přiřazen/a' : '+ Přiřadit se'}
                    </button>
                  )
                })()}
              </div>
            )}
          </div>

          {/* Stav */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Stav</label>
            {canChangeStatus ? (
              <select value={status} onChange={e => setStatus(e.target.value as TaskStatus)} className={inputClass}>
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : <StatusBadge status={task.status} />}
          </div>

          {/* Priorita */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Priorita</label>
            {canFullEdit ? (
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
            {canFullEdit ? (
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputClass} />
            ) : (
              <span className={`text-sm ${overdue ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'}`}>{formatDate(task.due_date)}</span>
            )}
          </div>

          {/* Cesta k souboru */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wide">Cesta k souboru</label>
            {canFullEdit ? (
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

        {/* 3D Model / Annotation link */}
        {canFullEdit ? (
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
                  <select value={annotationId ?? ''} onChange={e => setAnnotationId(e.target.value || null)} className={inputClass}>
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
                    <select value={annModelId} onChange={e => { setAnnModelId(e.target.value); setAnnotationId(null) }} className={inputClass}>
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

        {(canChangeStatus || canFullEdit) && (
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
            {([
              { id: 'comments',    label: `Komentáře (${comments.length})` },
              { id: 'attachments', label: attachments.length ? `Přílohy (${attachments.length})` : 'Přílohy' },
              { id: 'history',     label: 'Historie' },
            ] as const).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`pb-2 text-sm font-medium border-b-2 transition-colors ${activeTab === tab.id ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}>
                {tab.label}
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
                      {attachedImages.map((val, i) => (
                        <div key={i} className="relative group">
                          <AttImg value={val} className="h-16 w-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700 cursor-zoom-in"
                            onClick={setLightboxSrc} />
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

          {activeTab === 'attachments' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">{attachments.length === 0 ? 'Žádné přílohy.' : `${attachments.length} přílo${attachments.length === 1 ? 'ha' : attachments.length < 5 ? 'hy' : 'h'}`}</span>
                {canFullEdit && (
                  <button onClick={() => attachFileRef.current?.click()}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">
                    <Plus size={13} /> Přidat přílohu
                  </button>
                )}
              </div>
              {attachments.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {attachments.map(att => (
                    <AttachmentCard key={att.id} att={att} canEdit={canFullEdit}
                      onLightbox={setLightboxSrc} onDelete={handleDeleteAttachment} />
                  ))}
                </div>
              )}
              <input ref={attachFileRef} type="file" multiple className="hidden" onChange={handleAddAttachment} />
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-0 max-h-64 overflow-y-auto">
              {history.length === 0 ? (
                <p className="text-sm text-gray-400">Žádné záznamy o změnách.</p>
              ) : (history as Array<{ id: string; field: string; old_value: string | null; new_value: string | null; created_at: string; user?: { name: string } }>).map(h => (
                <div key={h.id} className="flex gap-3 py-2 border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                  <div className="w-6 h-6 rounded-full bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center shrink-0 mt-0.5 text-indigo-500 dark:text-indigo-400">
                    {h.field === 'stav' ? <CheckCircle size={12} /> : h.field === 'přiřazení' ? <span className="text-[10px] font-bold">@</span> : <span className="text-[10px]">✎</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-700 dark:text-gray-300 leading-snug">
                      <span className="font-semibold">{h.user?.name ?? '?'}</span>
                      {h.field === 'created'
                        ? <span className="text-gray-500"> vytvořil/a úkol</span>
                        : <> <span className="text-gray-500">změnil/a</span> <span className="font-medium">{h.field}</span></>
                      }
                    </p>
                    {h.field !== 'created' && (h.old_value || h.new_value) && (
                      <p className="text-[11px] text-gray-400 mt-0.5 truncate">
                        {h.old_value ?? '–'} <span className="text-gray-300 dark:text-gray-600">→</span> {h.new_value ?? '–'}
                      </p>
                    )}
                    <p className="text-[10px] text-gray-400 mt-0.5">{formatDateTime(h.created_at)}</p>
                  </div>
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
