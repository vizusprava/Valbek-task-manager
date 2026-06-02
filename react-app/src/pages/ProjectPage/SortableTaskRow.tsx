import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { GripVertical, MessageSquare, Copy } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Avatar } from '@/components/ui/Avatar'
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge'
import { InlineSelect, InlineDateInput } from '@/components/ui/InlineEdit'
import { formatDate, isOverdue, STATUS_LABELS, PRIORITY_LABELS, copyToClipboard } from '@/lib/utils'
import type { TaskWithRelations, Profile, TaskStatus, TaskPriority } from '@/lib/types'

function InlineAssigneeSelect({ assigneeIds, members, onChange }: {
  assigneeIds: string[]
  members: Profile[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(assigneeIds)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (!open) setPending(assigneeIds) }, [open, assigneeIds])

  function commit() { onChange(pending); setOpen(false) }

  useEffect(() => {
    if (!open) return
    function onMouse(e: MouseEvent) {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) commit()
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') commit() }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending])

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation()
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({ top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX })
    setOpen(o => !o)
  }

  function toggle(uid: string) {
    setPending(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid])
  }

  const assigned = members.filter(m => assigneeIds.includes(m.id))

  return (
    <div ref={triggerRef} className="inline-block cursor-pointer hover:opacity-75 transition-opacity" onClick={handleOpen} title="Kliknutím změnit">
      {assigned.length > 0 ? (
        <div className="flex -space-x-1.5 items-center">
          {assigned.slice(0, 3).map(m => <Avatar key={m.id} name={m.name} initials={m.initials} color={m.color} small />)}
          {assigned.length > 3 && <span className="text-xs text-gray-400 pl-2">+{assigned.length - 3}</span>}
        </div>
      ) : (
        <span className="text-xs text-gray-400">–</span>
      )}
      {open && createPortal(
        <div style={{ position: 'absolute', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl overflow-hidden min-w-44 py-1"
          onMouseDown={e => e.stopPropagation()}>
          {members.map(m => (
            <button key={m.id} onClick={e => { e.stopPropagation(); toggle(m.id) }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 ${pending.includes(m.id) ? 'text-indigo-600 dark:text-indigo-400 font-medium' : 'text-gray-700 dark:text-gray-300'}`}>
              <Avatar name={m.name} initials={m.initials} color={m.color} small />
              <span className="flex-1 text-left">{m.name}</span>
              {pending.includes(m.id) && <span className="text-xs text-indigo-500">✓</span>}
            </button>
          ))}
          {pending.length > 0 && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
              <button onClick={e => { e.stopPropagation(); setPending([]) }}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10">
                Zrušit přiřazení
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

export function SortableTaskRow({ task, admin, canEdit, canChangeStatus, selected, anySelected, members, currentUserId, onToggleSelect, onOpen, onDragSelectStart, onDragSelectEnter, onAssigneesChange, onSelfAssign, onStatusChange, onPriorityChange, onDueDateChange }: {
  task: TaskWithRelations; admin: boolean; canEdit: boolean; canChangeStatus: boolean
  selected: boolean; anySelected: boolean
  members: Profile[]
  currentUserId: string
  onToggleSelect: (id: string, shiftKey?: boolean) => void
  onOpen: () => void
  onDragSelectStart: (id: string) => void
  onDragSelectEnter: (id: string) => void
  onAssigneesChange: (taskId: string, ids: string[]) => void
  onSelfAssign: (taskId: string, add: boolean) => void
  onStatusChange: (taskId: string, val: TaskStatus) => void
  onPriorityChange: (taskId: string, val: TaskPriority) => void
  onDueDateChange: (taskId: string, val: string | null) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const overdue = isOverdue(task.due_date) && task.status !== 'hotovo' && task.status !== 'schváleno'
  const commentCount = task.comments?.[0]?.count ?? 0

  return (
    <tr ref={setNodeRef} style={style}
      onClick={anySelected ? undefined : onOpen}
      onMouseDown={anySelected ? (e: React.MouseEvent) => { if (e.button === 0) { e.preventDefault(); onDragSelectStart(task.id) } } : undefined}
      onMouseEnter={anySelected ? (e: React.MouseEvent) => { if (e.buttons === 1) onDragSelectEnter(task.id) } : undefined}
      className={`group border-b border-gray-50 dark:border-gray-800 last:border-0 cursor-pointer select-none
        ${selected ? 'bg-indigo-50 dark:bg-indigo-900/20' : (task.status === 'hotovo' || task.status === 'schváleno') ? 'bg-emerald-50/60 hover:bg-emerald-50 dark:bg-emerald-900/10 dark:hover:bg-emerald-900/20' : overdue ? 'bg-red-50/30 hover:bg-gray-50 dark:bg-red-900/5 dark:hover:bg-gray-800/50' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}
        ${isDragging ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}>
      <td className="pl-1.5 pr-1 py-2.5 w-12"
        onMouseDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onToggleSelect(task.id, e.shiftKey) }}>
        <div className="flex items-center justify-center gap-0.5">
          {admin && (
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
      <td className="px-3 py-2.5 hidden sm:table-cell align-middle">
        {admin ? (
          <InlineAssigneeSelect
            assigneeIds={(task.task_assignees ?? []).map(a => a.user_id)}
            members={members}
            onChange={ids => onAssigneesChange(task.id, ids)}
          />
        ) : (() => {
          const assignees = task.task_assignees ?? []
          const isSelf = assignees.some(a => a.user_id === currentUserId)
          return (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              {assignees.slice(0, 3).map(a => a.profiles ? (
                <Avatar key={a.user_id} name={a.profiles.name} initials={a.profiles.initials} color={a.profiles.color} small />
              ) : null)}
              {assignees.length > 3 && <span className="text-xs text-gray-400 pl-1">+{assignees.length - 3}</span>}
              {assignees.length === 0 && <span className="text-xs text-gray-400">–</span>}
              <button
                onClick={() => onSelfAssign(task.id, !isSelf)}
                title={isSelf ? 'Odebrat se' : 'Přiřadit se'}
                className={`ml-0.5 flex items-center justify-center w-5 h-5 rounded-full border text-[10px] font-bold transition-colors shrink-0 ${isSelf ? 'border-indigo-400 text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 dark:text-indigo-400' : 'border-dashed border-gray-300 dark:border-gray-600 text-gray-400 hover:border-indigo-400 hover:text-indigo-500'}`}
              >
                {isSelf ? '−' : '+'}
              </button>
            </div>
          )
        })()}
      </td>
      <td className="px-3 py-2.5">
        {canChangeStatus ? (
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
