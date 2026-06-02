import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus, ChevronDown, ChevronRight } from 'lucide-react'
import { STATUS_WEIGHTS } from '@/lib/utils'
import { SortableTaskRow } from './SortableTaskRow'
import type { TaskWithRelations, Profile, TaskStatus, TaskPriority } from '@/lib/types'

export function TaskGroup({ group, admin, profile, members, selectedTaskIds, activeDragId, onToggleSelect, onToggleGroup, onOpenTask, onCreateTask, onDragSelectStart, onDragSelectEnter, onAssigneesChange, onSelfAssign, onStatusChange, onPriorityChange, onDueDateChange }: {
  group: { id: string | null; name: string; tasks: TaskWithRelations[] }
  admin: boolean; profile: { id: string } | null
  members: Profile[]
  selectedTaskIds: Set<string>
  activeDragId: string | null
  onToggleSelect: (id: string, shiftKey?: boolean) => void
  onToggleGroup: (ids: string[]) => void
  onOpenTask: (task: TaskWithRelations) => void
  onCreateTask: (subprojectId: string) => void
  onDragSelectStart: (id: string) => void
  onDragSelectEnter: (id: string) => void
  onAssigneesChange: (taskId: string, ids: string[]) => void
  onSelfAssign: (taskId: string, add: boolean) => void
  onStatusChange: (taskId: string, val: TaskStatus) => void
  onPriorityChange: (taskId: string, val: TaskPriority) => void
  onDueDateChange: (taskId: string, val: string | null) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const total = group.tasks.length
  const weightedSum = group.tasks.reduce((sum, t) => sum + (STATUS_WEIGHTS[t.status] ?? 10), 0)
  const pct   = total > 0 ? Math.round(weightedSum / total) : 0
  const anySelected = selectedTaskIds.size > 0
  const allGroupSelected = total > 0 && group.tasks.every(t => selectedTaskIds.has(t.id))
  const someGroupSelected = !allGroupSelected && group.tasks.some(t => selectedTaskIds.has(t.id))

  const droppableId = group.id ?? '__null__'
  const { setNodeRef, isOver } = useDroppable({ id: droppableId })

  const showDropZone = activeDragId !== null && isOver

  return (
    <div ref={setNodeRef} className={`bg-white dark:bg-gray-900 rounded-xl border overflow-hidden mb-4 transition-colors ${showDropZone ? 'border-indigo-400 dark:border-indigo-500' : 'border-gray-200 dark:border-gray-800'}`}>
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
          <div className={`px-4 py-6 text-center text-sm transition-colors ${showDropZone ? 'text-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'text-gray-400'}`}>
            {showDropZone ? 'Přetáhněte sem' : (
              <>Žádné úkoly v této skupině.
                <button onClick={() => onCreateTask(group.id ?? '')} className="ml-2 text-indigo-600 dark:text-indigo-400 hover:underline">+ Přidat úkol</button>
              </>
            )}
          </div>
        ) : (
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
                    canEdit={admin || task.created_by === profile?.id}
                    canChangeStatus={admin || task.created_by === profile?.id || task.assigned_to === profile?.id || (task.task_assignees ?? []).some(a => a.user_id === profile?.id)}
                    selected={selectedTaskIds.has(task.id)}
                    anySelected={anySelected}
                    members={members}
                    currentUserId={profile?.id ?? ''}
                    onToggleSelect={onToggleSelect}
                    onOpen={() => onOpenTask(task)}
                    onDragSelectStart={onDragSelectStart}
                    onDragSelectEnter={onDragSelectEnter}
                    onAssigneesChange={onAssigneesChange}
                    onSelfAssign={onSelfAssign}
                    onStatusChange={onStatusChange}
                    onPriorityChange={onPriorityChange}
                    onDueDateChange={onDueDateChange}
                  />
                ))}
              </tbody>
            </table>
          </SortableContext>
        )
      )}
    </div>
  )
}
