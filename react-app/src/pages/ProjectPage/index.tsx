import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Copy, ChevronDown, X, MoreHorizontal, CheckCircle, Settings, Trash2, BookTemplate, Box } from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragOverlay,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { snapCenterToCursor } from '@dnd-kit/modifiers'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageLayout } from '@/components/layout/PageLayout'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { ManageTaskTemplatesModal } from '@/components/ui/TaskTemplatesModal'
import { formatDate, isOverdue, STATUS_LABELS, PRIORITY_LABELS, copyToClipboard } from '@/lib/utils'
import type { Project, Profile, Subproject, TaskWithRelations, TaskStatus, TaskPriority } from '@/lib/types'
import { TaskDetailModal } from './TaskDetailModal'
import { CreateTaskModal } from './CreateTaskModal'
import { TaskGroup } from './TaskGroup'
import { ManageSubprojectsModal } from './ManageSubprojectsModal'
import { EditProjectModal } from './EditProjectModal'
import { BulkCreateTasksModal } from './BulkCreateTasksModal'

function SkeletonTaskGroups() {
  return (
    <>
      {[0, 1, 2].map(i => (
        <div key={i} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden mb-4 animate-pulse">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-32" />
            <div className="ml-auto h-3.5 bg-gray-200 dark:bg-gray-700 rounded w-12" />
          </div>
          {[0, 1, 2].map(j => (
            <div key={j} className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 dark:border-gray-800/50 last:border-0">
              <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-2/3" />
              <div className="ml-auto h-3 bg-gray-100 dark:bg-gray-800 rounded w-16" />
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

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
  const [selectedTaskId,  setSelectedTaskId]  = useState<string | null>(null)
  const [showCreate,      setShowCreate]      = useState(false)
  const [createSubId,     setCreateSubId]     = useState('')
  const [showEditProject,       setShowEditProject]       = useState(false)
  const [showManageSubprojects, setShowManageSubprojects] = useState(false)
  const [selectedTaskIds,   setSelectedTaskIds]   = useState<Set<string>>(new Set())
  const [showTemplatesModal, setShowTemplatesModal] = useState(false)
  const [showBulkCreate,    setShowBulkCreate]    = useState(false)
  const [showAdminMenu,     setShowAdminMenu]     = useState(false)
  const [activeDragId,      setActiveDragId]      = useState<string | null>(null)
  const [showModels,        setShowModels]        = useState(false)
  const lastSelectedId    = useRef<string | null>(null)
  const adminMenuRef      = useRef<HTMLDivElement>(null)
  const isDragSelectActive = useRef(false)
  const isDragSelectAdd    = useRef(true)
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => {
    if (!showAdminMenu) return
    function onMouse(e: MouseEvent) {
      if (adminMenuRef.current && !adminMenuRef.current.contains(e.target as Node)) setShowAdminMenu(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setShowAdminMenu(false) }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey) }
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

  const { data: subprojects = [], isLoading: subprojectsLoading } = useQuery<Subproject[]>({
    queryKey: ['subprojects', projectId],
    queryFn: async () => {
      const { data } = await supabase.from('subprojects').select('*').eq('project_id', projectId!).order('sort_order')
      return (data || []) as Subproject[]
    },
    enabled: !!projectId,
  })

  const { data: tasks = [], isLoading: tasksLoading } = useQuery<TaskWithRelations[]>({
    queryKey: ['tasks', projectId],
    queryFn: async () => {
      const { data } = await supabase.from('tasks')
        .select('*, comments(count), assigned:assigned_to(id, name, initials, color), creator:created_by(id, name), updater:updated_by(id, name), task_assignees(user_id, profiles(id, name, initials, color)), linked_model:model_id(id, name), annotation:annotation_id(id, text, object_name, x, y, z, model_id, model:model_id(id, name))')
        .eq('project_id', projectId!)
        .order('sort_order', { ascending: true })
      return (data || []) as TaskWithRelations[]
    },
    enabled: !!projectId,
  })

  const selectedTask = selectedTaskId ? (tasks.find(t => t.id === selectedTaskId) ?? null) : null

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
    const byTitle = (a: TaskWithRelations, b: TaskWithRelations) => a.title.localeCompare(b.title, 'cs')
    const result: { id: string | null; name: string; tasks: TaskWithRelations[] }[] = subprojects.map(sp => ({
      id: sp.id,
      name: sp.name,
      tasks: filteredTasks.filter(t => t.subproject_id === sp.id).sort(byTitle),
    }))
    const orphans = filteredTasks.filter(t => !t.subproject_id).sort(byTitle)
    if (orphans.length > 0 || subprojects.length === 0) {
      result.push({ id: null, name: 'Bez podprojektu', tasks: orphans })
    }
    return result
  }, [subprojects, filteredTasks])

  const allTasksInOrder = useMemo(() => groups.flatMap(g => g.tasks), [groups])

  const { data: projectModels = [] } = useQuery({
    queryKey: ['project_models', projectId],
    queryFn: async () => {
      const { data } = await supabase.from('model_files').select('id, name, thumbnail_path, file_path').eq('project_id', projectId!)
      return (data ?? []) as { id: string; name: string; thumbnail_path: string | null; file_path: string }[]
    },
    enabled: !!projectId && showModels,
  })

  // ── Inline status/priority update ─────────────────────────

  async function handleStatusChange(taskId: string, val: TaskStatus) {
    if (!profile) return
    const old = tasks.find(t => t.id === taskId)
    await supabase.from('tasks').update({ status: val, updated_by: profile.id }).eq('id', taskId)
    if (old && old.status !== val) {
      await supabase.from('task_activity').insert({ task_id: taskId, user_id: profile.id, field: 'stav', old_value: STATUS_LABELS[old.status], new_value: STATUS_LABELS[val] })
      queryClient.invalidateQueries({ queryKey: ['task-history', taskId] })
    }
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handlePriorityChange(taskId: string, val: TaskPriority) {
    if (!profile) return
    const old = tasks.find(t => t.id === taskId)
    await supabase.from('tasks').update({ priority: val, updated_by: profile.id }).eq('id', taskId)
    if (old && old.priority !== val) {
      await supabase.from('task_activity').insert({ task_id: taskId, user_id: profile.id, field: 'priorita', old_value: PRIORITY_LABELS[old.priority], new_value: PRIORITY_LABELS[val] })
      queryClient.invalidateQueries({ queryKey: ['task-history', taskId] })
    }
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handleDueDateChange(taskId: string, val: string | null) {
    if (!profile) return
    const old = tasks.find(t => t.id === taskId)
    await supabase.from('tasks').update({ due_date: val, updated_by: profile.id }).eq('id', taskId)
    if (old && old.due_date !== val) {
      await supabase.from('task_activity').insert({ task_id: taskId, user_id: profile.id, field: 'termín', old_value: formatDate(old.due_date), new_value: formatDate(val) })
      queryClient.invalidateQueries({ queryKey: ['task-history', taskId] })
    }
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  // ── Drag & drop ────────────────────────────────────────────

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id))
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveDragId(null)
    if (!over) return

    const activeId = String(active.id)
    const overId   = String(over.id)
    if (activeId === overId) return

    const activeTask = tasks.find(t => t.id === activeId)
    if (!activeTask) return

    const overTask = tasks.find(t => t.id === overId)
    const targetSubId: string | null = overTask
      ? (overTask.subproject_id ?? null)
      : (overId === '__null__' ? null : overId)

    const isDraggingSelection = selectedTaskIds.size > 1 && selectedTaskIds.has(activeId)

    const targetSubName = subprojects.find(s => s.id === targetSubId)?.name ?? 'Bez podprojektu'

    if (isDraggingSelection) {
      const orderedSelected = tasks.filter(t => selectedTaskIds.has(t.id))
      const targetTasks = tasks.filter(t => (t.subproject_id ?? null) === targetSubId && !selectedTaskIds.has(t.id))
      const maxOrder = targetTasks.length > 0 ? Math.max(...targetTasks.map(t => t.sort_order ?? 0)) : 0
      const updates = orderedSelected.map((t, i) =>
        supabase.from('tasks').update({ subproject_id: targetSubId, sort_order: maxOrder + (i + 1) * 10 }).eq('id', t.id)
      )
      await Promise.all(updates)
      const movedCross = orderedSelected.filter(t => (t.subproject_id ?? null) !== targetSubId)
      if (movedCross.length > 0 && profile) {
        await supabase.from('task_activity').insert(movedCross.map(t => ({
          task_id: t.id, user_id: profile.id, field: 'podprojekt',
          old_value: subprojects.find(s => s.id === (t.subproject_id ?? null))?.name ?? 'Bez podprojektu',
          new_value: targetSubName,
        })))
        movedCross.forEach(t => queryClient.invalidateQueries({ queryKey: ['task-history', t.id] }))
      }
      setSelectedTaskIds(new Set())
    } else {
      const activeSubId = activeTask.subproject_id ?? null
      if (activeSubId !== targetSubId) {
        const targetTasks = tasks.filter(t => (t.subproject_id ?? null) === targetSubId)
        const maxOrder = targetTasks.length > 0 ? Math.max(...targetTasks.map(t => t.sort_order ?? 0)) : 0
        await supabase.from('tasks').update({ subproject_id: targetSubId, sort_order: maxOrder + 10 }).eq('id', activeId)
        if (profile) {
          await supabase.from('task_activity').insert({ task_id: activeId, user_id: profile.id, field: 'podprojekt', old_value: subprojects.find(s => s.id === activeSubId)?.name ?? 'Bez podprojektu', new_value: targetSubName })
          queryClient.invalidateQueries({ queryKey: ['task-history', activeId] })
        }
      } else {
        const subTasks = tasks.filter(t => (t.subproject_id ?? null) === activeSubId)
        const oldIndex = subTasks.findIndex(t => t.id === activeId)
        const newIndex = subTasks.findIndex(t => t.id === overId)
        if (oldIndex === -1 || newIndex === -1) return
        const reordered = arrayMove(subTasks, oldIndex, newIndex)
        const updates = reordered.map((t, i) => supabase.from('tasks').update({ sort_order: (i + 1) * 10 }).eq('id', t.id))
        await Promise.all(updates)
      }
    }

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

  async function handleSelfAssign(taskId: string, add: boolean) {
    if (!profile) return
    if (add) {
      const { error } = await supabase.from('task_assignees').upsert({ task_id: taskId, user_id: profile.id }, { onConflict: 'task_id,user_id' })
      if (error) { toast.error('Nepodařilo se přiřadit: ' + error.message); return }
    } else {
      const { error } = await supabase.from('task_assignees').delete().eq('task_id', taskId).eq('user_id', profile.id)
      if (error) { toast.error('Nepodařilo se odebrat přiřazení: ' + error.message); return }
    }
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  async function handleAssigneesChange(taskId: string, assigneeIds: string[]) {
    if (!profile) return
    const assigned_to = assigneeIds[0] || null

    const { data: current } = await supabase.from('task_assignees').select('user_id').eq('task_id', taskId)
    const prevIds = (current ?? []).map(r => r.user_id)
    const newNotifyIds = assigneeIds.filter(id => !prevIds.includes(id) && id !== profile.id)

    await supabase.from('tasks').update({ assigned_to, updated_by: profile.id }).eq('id', taskId)
    await supabase.from('task_assignees').delete().eq('task_id', taskId)
    if (assigneeIds.length > 0)
      await supabase.from('task_assignees').insert(assigneeIds.map(uid => ({ task_id: taskId, user_id: uid })))

    const sortedPrev = [...prevIds].sort().join(',')
    const sortedNew  = [...assigneeIds].sort().join(',')
    if (sortedPrev !== sortedNew) {
      await supabase.from('task_activity').insert({
        task_id: taskId, user_id: profile.id, field: 'přiřazení',
        old_value: prevIds.map(id => members.find(m => m.id === id)?.name ?? '?').join(', ') || null,
        new_value: assigneeIds.map(id => members.find(m => m.id === id)?.name ?? '?').join(', ') || null,
      })
      queryClient.invalidateQueries({ queryKey: ['task-history', taskId] })
    }

    if (newNotifyIds.length > 0) {
      const taskTitle = tasks.find(t => t.id === taskId)?.title ?? ''
      await supabase.from('notifications').insert(
        newNotifyIds.map(uid => ({ user_id: uid, type: 'task_assigned', message: `Byl/a jsi přiřazen/a k úkolu: ${taskTitle}`, task_id: taskId, project_id: projectId }))
      )
    }

    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] })
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
    const { error } = await supabase.from('projects').delete().eq('id', projectId!)
    if (error) { toast.error(error.message); return }
    queryClient.invalidateQueries({ queryKey: ['projects'] })
    toast.success('Projekt smazán.')
    navigate('/dashboard')
  }

  if (!project) {
    return (
      <PageLayout>
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
                  <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-30 min-w-47.5 overflow-hidden py-1">
                    <button onClick={() => { setShowEditProject(true); setShowAdminMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2.5">
                      <Settings size={14} className="shrink-0" /> Upravit projekt
                    </button>
                    <button onClick={() => { setShowManageSubprojects(true); setShowAdminMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2.5">
                      <ChevronDown size={14} className="shrink-0" /> Podprojekty
                    </button>
                    <button onClick={() => { setShowTemplatesModal(true); setShowAdminMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2.5">
                      <BookTemplate size={14} className="shrink-0" /> Šablony úkolů
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
      {subprojectsLoading || tasksLoading ? <SkeletonTaskGroups /> : null}
      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {!subprojectsLoading && !tasksLoading && groups.map(group => (
          <TaskGroup key={group.id ?? '__none__'} group={group}
            admin={admin} profile={profile}
            members={members}
            selectedTaskIds={selectedTaskIds}
            activeDragId={activeDragId}
            onToggleSelect={toggleTaskSelection}
            onToggleGroup={toggleGroupSelection}
            onOpenTask={t => setSelectedTaskId(t.id)}
            onCreateTask={subId => { setCreateSubId(subId); setShowCreate(true) }}
            onDragSelectStart={handleDragSelectStart}
            onDragSelectEnter={handleDragSelectEnter}
            onAssigneesChange={handleAssigneesChange}
            onSelfAssign={handleSelfAssign}
            onStatusChange={handleStatusChange}
            onPriorityChange={handlePriorityChange}
            onDueDateChange={handleDueDateChange}
          />
        ))}
        <DragOverlay modifiers={[snapCenterToCursor]}>
          {activeDragId && (() => {
            const isMulti = selectedTaskIds.size > 1 && selectedTaskIds.has(activeDragId)
            const t = tasks.find(x => x.id === activeDragId)
            if (!t) return null
            return (
              <div className="px-3 py-2 bg-white dark:bg-gray-800 border border-indigo-300 dark:border-indigo-600 rounded-lg shadow-xl text-sm font-medium text-gray-800 dark:text-gray-200 cursor-grabbing max-w-sm flex items-center gap-2">
                {isMulti && (
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs font-bold shrink-0">
                    {selectedTaskIds.size}
                  </span>
                )}
                <span className="truncate">{isMulti ? `${selectedTaskIds.size} vybrané úkoly` : t.title}</span>
              </div>
            )
          })()}
        </DragOverlay>
      </DndContext>

      {/* Bulk action bar */}
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
        onClose={() => setSelectedTaskId(null)}
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

      {/* 3D Modely sekce */}
      <div className="mt-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <button
          onClick={() => setShowModels(v => !v)}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
        >
          <Box size={15} className="text-indigo-400 shrink-0" />
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">3D Modely</span>
          {projectModels.length > 0 && <span className="text-xs text-gray-400">({projectModels.length})</span>}
          <ChevronDown size={14} className={`ml-auto text-gray-400 transition-transform ${showModels ? 'rotate-180' : ''}`} />
        </button>
        {showModels && (
          <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-800 pt-3">
            {projectModels.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <Box size={32} className="mx-auto mb-2 opacity-25" />
                <p className="text-sm">Žádné 3D modely přiřazené k tomuto projektu.</p>
                <Link to="/models" className="mt-2 inline-block text-xs text-indigo-500 hover:underline">Přejít na 3D Modely →</Link>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {projectModels.map(model => {
                  const thumbUrl = model.thumbnail_path
                    ? supabase.storage.from('models').getPublicUrl(model.thumbnail_path).data.publicUrl
                    : null
                  return (
                    <Link key={model.id} to={`/models?model=${model.id}`}
                      className="group rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all">
                      <div className="h-28 bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden">
                        {thumbUrl
                          ? <img src={thumbUrl} alt={model.name} className="w-full h-full object-cover" />
                          : <Box size={32} className="text-gray-300 dark:text-gray-600 group-hover:text-indigo-400 transition-colors" />}
                      </div>
                      <div className="px-2 py-1.5">
                        <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{model.name}</p>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

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
