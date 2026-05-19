import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ClipboardCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { PageLayout } from '@/components/layout/PageLayout'
import { Avatar } from '@/components/ui/Avatar'
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge'
import { InlineSelect, InlineDateInput } from '@/components/ui/InlineEdit'
import { STATUS_LABELS, PRIORITY_LABELS } from '@/lib/utils'
import type { TaskWithRelations, TaskStatus, TaskPriority } from '@/lib/types'

// ── Data fetching ─────────────────────────────────────────────

async function fetchReviewTasks(): Promise<TaskWithRelations[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      *,
      assigned:profiles!tasks_assigned_to_fkey(id, name, initials, color),
      creator:profiles!tasks_created_by_fkey(id, name),
      updater:profiles!tasks_updated_by_fkey(id, name),
      comments(count),
      project:projects!tasks_project_id_fkey(id, name),
      subproject:subprojects!tasks_subproject_id_fkey(id, name)
    `)
    .eq('status', 'připraveno ke kontrole')
    .order('due_date', { ascending: true, nullsFirst: false })

  if (error) throw error
  return (data ?? []) as unknown as TaskWithRelations[]
}

// ── Main page ─────────────────────────────────────────────────

export function ReviewPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['review-tasks'],
    queryFn: fetchReviewTasks,
  })

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('review-tasks-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
        queryClient.invalidateQueries({ queryKey: ['review-tasks'] })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [queryClient])

  async function handleStatusChange(task: TaskWithRelations, status: TaskStatus) {
    const { error } = await supabase.from('tasks').update({ status }).eq('id', task.id)
    if (error) { toast.error('Chyba při ukládání'); return }
    queryClient.invalidateQueries({ queryKey: ['review-tasks'] })
  }

  async function handlePriorityChange(task: TaskWithRelations, priority: TaskPriority) {
    const { error } = await supabase.from('tasks').update({ priority }).eq('id', task.id)
    if (error) { toast.error('Chyba při ukládání'); return }
    queryClient.invalidateQueries({ queryKey: ['review-tasks'] })
  }

  async function handleDueDateChange(task: TaskWithRelations, val: string | null) {
    const { error } = await supabase.from('tasks').update({ due_date: val }).eq('id', task.id)
    if (error) { toast.error('Chyba při ukládání'); return }
    queryClient.invalidateQueries({ queryKey: ['review-tasks'] })
  }

  // Group by project
  const groups = Object.values(
    tasks.reduce<Record<string, { projectId: string; projectName: string; tasks: TaskWithRelations[] }>>((acc, t) => {
      const pid = t.project_id
      if (!acc[pid]) acc[pid] = { projectId: pid, projectName: t.project?.name ?? 'Neznámý projekt', tasks: [] }
      acc[pid].tasks.push(t)
      return acc
    }, {})
  )

  return (
    <PageLayout>
      <div className="flex items-center gap-3 mb-6">
        <ClipboardCheck size={22} className="text-amber-500" />
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Ke kontrole</h1>
        {tasks.length > 0 && (
          <span className="ml-1 text-sm text-gray-500 dark:text-gray-400">({tasks.length})</span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-gray-400">Načítám…</div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-400">
          <ClipboardCheck size={36} className="opacity-40" />
          <p className="text-sm">Žádné úkoly ke kontrole</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(group => (
            <div key={group.projectId} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
              <div
                className="flex items-center gap-2 px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                onClick={() => navigate(`/project/${group.projectId}`)}
              >
                <span className="font-semibold text-gray-900 dark:text-gray-100 text-sm">{group.projectName}</span>
                <span className="text-xs text-gray-400 ml-1">({group.tasks.length})</span>
                <span className="ml-auto text-xs text-indigo-500 hover:underline">Otevřít projekt →</span>
              </div>

              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                    <th className="text-left px-4 py-2 font-medium">Úkol</th>
                    <th className="text-left px-4 py-2 font-medium w-36">Řešitel</th>
                    <th className="text-left px-4 py-2 font-medium w-36">Stav</th>
                    <th className="text-left px-4 py-2 font-medium w-28">Priorita</th>
                    <th className="text-left px-4 py-2 font-medium w-32">Termín</th>
                  </tr>
                </thead>
                <tbody>
                  {group.tasks.map(task => (
                    <tr
                      key={task.id}
                      className="border-b border-gray-50 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
                      onClick={() => navigate(`/project/${task.project_id}`)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1">{task.title}</div>
                        {task.subproject && (
                          <div className="text-xs text-gray-400 mt-0.5">{task.subproject.name}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {task.assigned ? (
                          <div className="flex items-center gap-2">
                            <Avatar
                              name={task.assigned.name}
                              initials={task.assigned.initials}
                              color={task.assigned.color}
                              small
                            />
                            <span className="text-gray-700 dark:text-gray-300 text-xs">{task.assigned.name}</span>
                          </div>
                        ) : (
                          <span className="text-gray-400 text-xs">–</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <InlineSelect<TaskStatus>
                          value={task.status}
                          options={STATUS_LABELS}
                          onChange={val => handleStatusChange(task, val)}
                          renderBadge={() => <StatusBadge status={task.status} />}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <InlineSelect<TaskPriority>
                          value={task.priority}
                          options={PRIORITY_LABELS}
                          onChange={val => handlePriorityChange(task, val)}
                          renderBadge={() => <PriorityBadge priority={task.priority} />}
                        />
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <InlineDateInput value={task.due_date} onChange={val => handleDueDateChange(task, val)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </PageLayout>
  )
}
