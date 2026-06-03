import { useState, useRef, useEffect, useCallback } from 'react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, horizontalListSortingStrategy, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, GripHorizontal, Plus, Trash2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Spreadsheet, SpreadsheetData, SpreadsheetCell } from '@/lib/types'

const COL_W = 140  // px — šířka buňky/sloupce
const ROW_LABEL_W = 120  // px — šířka sloupce s názvem řádku
const HANDLE_W = 32  // px — šířka sloupce s gripem

// ── Inline editable label (sdílené pro sloupce i řádky) ───────

function EditableLabel({ value, onCommit, className }: {
  value: string
  onCommit: (v: string) => void
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) ref.current?.select() }, [editing])
  useEffect(() => { if (!editing) setVal(value) }, [value, editing])

  function commit() {
    setEditing(false)
    const trimmed = val.trim()
    if (trimmed !== value) onCommit(trimmed)
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(value); setEditing(false) } }}
        className="flex-1 min-w-0 text-xs font-semibold bg-white dark:bg-gray-700 border border-indigo-400 rounded px-1 py-0.5 outline-none text-gray-800 dark:text-gray-100"
      />
    )
  }

  return (
    <span
      className={`flex-1 min-w-0 truncate text-xs font-semibold cursor-text select-none ${className ?? 'text-gray-700 dark:text-gray-300'}`}
      onDoubleClick={() => setEditing(true)}
      title="Dvojklik pro přejmenování"
    >
      {value || <span className="text-gray-300 dark:text-gray-600 italic">—</span>}
    </span>
  )
}

// ── Sortable column header ────────────────────────────────────

function SortableColHeader({ id, name, onRename, onDelete }: {
  id: string; name: string
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, width: COL_W, minWidth: COL_W }

  return (
    <div ref={setNodeRef} style={style}
      className="group flex items-center gap-1 px-2 py-2 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 shrink-0">
      <span {...attributes} {...listeners}
        className="cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 shrink-0 touch-none">
        <GripHorizontal size={13} />
      </span>
      <EditableLabel value={name} onCommit={v => onRename(id, v || name)} />
      <button
        onClick={() => onDelete(id)}
        className="opacity-0 group-hover:opacity-100 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 shrink-0 transition-opacity"
      >
        <span className="text-sm leading-none">×</span>
      </button>
    </div>
  )
}

// ── Sortable row ──────────────────────────────────────────────

function SortableRow({ id, name, onRename, onDelete, children }: {
  id: string; name: string
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <div ref={setNodeRef} style={style} className="flex border-b border-gray-100 dark:border-gray-800 last:border-0 group/row">
      {/* Drag handle */}
      <div style={{ width: HANDLE_W, minWidth: HANDLE_W }} className="shrink-0 flex items-center justify-center border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
        <span {...attributes} {...listeners}
          className="cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 touch-none">
          <GripVertical size={13} />
        </span>
      </div>
      {/* Row label */}
      <div style={{ width: ROW_LABEL_W, minWidth: ROW_LABEL_W }}
        className="group shrink-0 flex items-center gap-1 px-2 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
        <EditableLabel value={name} onCommit={v => onRename(id, v)} className="text-gray-600 dark:text-gray-400" />
      </div>
      {/* Cells */}
      {children}
      {/* Delete row */}
      <button
        onClick={() => onDelete(id)}
        className="flex items-center justify-center w-10 shrink-0 opacity-0 group-hover/row:opacity-100 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-all border-l border-gray-100 dark:border-gray-800"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

// ── SpreadsheetEditor ────────────────────────────────────────

export function SpreadsheetEditor({ spreadsheet, onSaved }: {
  spreadsheet: Spreadsheet
  onSaved: () => void
}) {
  const { profile } = useAuthStore()
  const [data, setData] = useState<SpreadsheetData>(spreadsheet.data)
  const [tableName, setTableName] = useState(spreadsheet.name)
  const [editingName, setEditingName] = useState(false)
  const [editingCell, setEditingCell] = useState<{ rowId: string; colId: string } | null>(null)
  const [editVal, setEditVal] = useState('')
  const [saved, setSaved] = useState(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editingName) nameRef.current?.select() }, [editingName])

  // Realtime — reload when another user saves
  useEffect(() => {
    const ch = supabase.channel(`spreadsheet-${spreadsheet.id}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'spreadsheets',
        filter: `id=eq.${spreadsheet.id}`,
      }, payload => {
        const updated = payload.new as Spreadsheet
        if (updated.updated_by !== profile?.id) {
          setData(updated.data)
          setTableName(updated.name)
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [spreadsheet.id, profile?.id])

  const persist = useCallback((nextData: SpreadsheetData, nextName?: string) => {
    setSaved(false)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const { error } = await supabase.from('spreadsheets').update({
        data: nextData,
        name: nextName ?? tableName,
        updated_by: profile?.id,
        updated_at: new Date().toISOString(),
      }).eq('id', spreadsheet.id)
      if (error) toast.error('Chyba při ukládání: ' + error.message)
      else { setSaved(true); onSaved() }
    }, 800)
  }, [spreadsheet.id, profile?.id, tableName, onSaved])

  function update(nextData: SpreadsheetData) { setData(nextData); persist(nextData) }

  function commitName() {
    setEditingName(false)
    const trimmed = tableName.trim() || spreadsheet.name
    setTableName(trimmed)
    persist(data, trimmed)
  }

  // ── Columns ────────────────────────────────────────────────

  function addColumn() {
    update({ ...data, columns: [...data.columns, { id: crypto.randomUUID(), name: `Sloupec ${data.columns.length + 1}`, width: COL_W }] })
  }

  function renameColumn(colId: string, name: string) {
    update({ ...data, columns: data.columns.map(c => c.id === colId ? { ...c, name } : c) })
  }

  function deleteColumn(colId: string) {
    update({
      columns: data.columns.filter(c => c.id !== colId),
      rows: data.rows.map(r => { const cells = { ...r.cells }; delete cells[colId]; return { ...r, cells } }),
    })
  }

  // ── Rows ───────────────────────────────────────────────────

  function addRow() {
    update({ ...data, rows: [...data.rows, { id: crypto.randomUUID(), name: '', cells: {} }] })
  }

  function renameRow(rowId: string, name: string) {
    update({ ...data, rows: data.rows.map(r => r.id === rowId ? { ...r, name } : r) })
  }

  function deleteRow(rowId: string) {
    update({ ...data, rows: data.rows.filter(r => r.id !== rowId) })
  }

  // ── Cells ──────────────────────────────────────────────────

  function startEdit(rowId: string, colId: string) {
    setEditingCell({ rowId, colId })
    setEditVal(data.rows.find(r => r.id === rowId)?.cells[colId]?.value ?? '')
  }

  function commitEdit() {
    if (!editingCell) return
    const { rowId, colId } = editingCell
    update({
      ...data,
      rows: data.rows.map(r => r.id !== rowId ? r : {
        ...r, cells: { ...r.cells, [colId]: { value: editVal } },
      }),
    })
    setEditingCell(null)
  }

  // ── Drag & drop ────────────────────────────────────────────

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleColDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    update({ ...data, columns: arrayMove(data.columns, data.columns.findIndex(c => c.id === active.id), data.columns.findIndex(c => c.id === over.id)) })
  }

  function handleRowDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    update({ ...data, rows: arrayMove(data.rows, data.rows.findIndex(r => r.id === active.id), data.rows.findIndex(r => r.id === over.id)) })
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Název tabulky */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          {editingName ? (
            <input
              ref={nameRef}
              value={tableName}
              onChange={e => setTableName(e.target.value)}
              onBlur={commitName}
              onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setTableName(spreadsheet.name); setEditingName(false) } }}
              className="text-xl font-bold bg-transparent border-b-2 border-indigo-500 outline-none text-gray-900 dark:text-gray-100 min-w-0"
            />
          ) : (
            <h1
              className="text-xl font-bold text-gray-900 dark:text-gray-100 cursor-text hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
              onDoubleClick={() => setEditingName(true)}
              title="Dvojklik pro přejmenování"
            >{tableName}</h1>
          )}
        </div>
        <span className={`text-xs font-medium shrink-0 flex items-center gap-1 ${saved ? 'text-green-600 dark:text-green-400' : 'text-amber-500'}`}>
          {saved ? <><Check size={12} /> uloženo</> : '● ukládám…'}
        </span>
      </div>

      {/* Tabulka */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-auto shadow-sm">

        {/* Hlavička sloupců */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10 bg-gray-50 dark:bg-gray-800/80">
          {/* Roh — zarovnání s gripem + názvem řádku */}
          <div style={{ width: HANDLE_W + ROW_LABEL_W, minWidth: HANDLE_W + ROW_LABEL_W }}
            className="shrink-0 border-r border-gray-200 dark:border-gray-700 px-2 flex items-center">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">Řádek</span>
          </div>
          {/* Přesunutelné hlavičky sloupců */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleColDragEnd}>
            <SortableContext items={data.columns.map(c => c.id)} strategy={horizontalListSortingStrategy}>
              {data.columns.map(col => (
                <SortableColHeader key={col.id} id={col.id} name={col.name} onRename={renameColumn} onDelete={deleteColumn} />
              ))}
            </SortableContext>
          </DndContext>
          {/* Přidat sloupec */}
          <button
            onClick={addColumn}
            className="flex items-center justify-center w-10 shrink-0 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 dark:hover:text-indigo-400 transition-colors border-l border-gray-200 dark:border-gray-700"
            title="Přidat sloupec"
          >
            <Plus size={15} />
          </button>
        </div>

        {/* Řádky */}
        {data.rows.length === 0 && data.columns.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            Přidej sloupce a řádky tlačítky +
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleRowDragEnd}>
            <SortableContext items={data.rows.map(r => r.id)} strategy={verticalListSortingStrategy}>
              {data.rows.map(row => (
                <SortableRow
                  key={row.id}
                  id={row.id}
                  name={row.name ?? ''}
                  onRename={renameRow}
                  onDelete={deleteRow}
                >
                  {data.columns.map(col => {
                    const cell: SpreadsheetCell = row.cells[col.id] ?? { value: '' }
                    const isEditing = editingCell?.rowId === row.id && editingCell?.colId === col.id

                    return (
                      <div
                        key={col.id}
                        style={{ width: COL_W, minWidth: COL_W }}
                        className="relative shrink-0 border-r border-gray-100 dark:border-gray-800"
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editVal}
                            onChange={e => setEditVal(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingCell(null) }}
                            className="absolute inset-0 w-full h-full px-2 py-1.5 text-sm bg-white dark:bg-gray-800 border-2 border-indigo-500 outline-none z-10 text-gray-900 dark:text-white"
                          />
                        ) : (
                          <div
                            className="px-2 py-1.5 text-sm min-h-[36px] cursor-text whitespace-pre-wrap break-words text-gray-900 dark:text-white"
                            onClick={() => startEdit(row.id, col.id)}
                          >
                            {cell.value}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </SortableRow>
              ))}
            </SortableContext>
          </DndContext>
        )}

        {/* Přidat řádek */}
        <button
          onClick={addRow}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/10 dark:hover:text-indigo-400 transition-colors border-t border-gray-100 dark:border-gray-800"
        >
          <Plus size={14} /> Přidat řádek
        </button>
      </div>
    </div>
  )
}
