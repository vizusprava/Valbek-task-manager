import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, horizontalListSortingStrategy, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, GripHorizontal, Plus, Trash2, Palette, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { ColorPicker } from '@/components/ui/ColorPicker'
import type { Spreadsheet, SpreadsheetData, SpreadsheetCell } from '@/lib/types'

// ── Sortable column header ────────────────────────────────────

function SortableColHeader({ id, name, onRename, onDelete }: {
  id: string
  name: string
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  function commit() {
    setEditing(false)
    const trimmed = val.trim() || name
    setVal(trimmed)
    if (trimmed !== name) onRename(id, trimmed)
  }

  return (
    <div ref={setNodeRef} style={style}
      className="group flex items-center gap-1 px-2 py-2 min-w-[140px] w-[140px] border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 select-none relative shrink-0">
      <span {...attributes} {...listeners}
        className="cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 shrink-0 touch-none">
        <GripHorizontal size={13} />
      </span>
      {editing ? (
        <input
          ref={inputRef}
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(name); setEditing(false) } }}
          className="flex-1 min-w-0 text-xs font-semibold bg-white dark:bg-gray-700 border border-indigo-400 rounded px-1 py-0.5 outline-none text-gray-800 dark:text-gray-100"
        />
      ) : (
        <span
          className="flex-1 min-w-0 truncate text-xs font-semibold text-gray-700 dark:text-gray-300 cursor-text"
          onDoubleClick={() => setEditing(true)}
          title="Dvojklik pro přejmenování"
        >{name}</span>
      )}
      <button
        onClick={() => onDelete(id)}
        className="opacity-0 group-hover:opacity-100 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 shrink-0 transition-opacity"
      >
        <X size={12} />
      </button>
    </div>
  )
}

// ── Sortable row ──────────────────────────────────────────────

function SortableRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <div ref={setNodeRef} style={style} className="flex border-b border-gray-100 dark:border-gray-800 last:border-0 group/row">
      <div className="w-8 shrink-0 flex items-center justify-center border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
        <span {...attributes} {...listeners}
          className="cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 touch-none">
          <GripVertical size={13} />
        </span>
      </div>
      {children}
    </div>
  )
}

// ── Cell color popover ────────────────────────────────────────

function CellColorPopover({ cell, pos, onClose, onChange }: {
  cell: SpreadsheetCell
  pos: { x: number; y: number }
  onClose: () => void
  onChange: (patch: Partial<SpreadsheetCell>) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'bg' | 'text'>('bg')

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(pos.y, window.innerHeight - 340),
    left: Math.min(pos.x, window.innerWidth - 240),
    zIndex: 9999,
  }

  return createPortal(
    <div ref={ref} style={style} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-3 w-56">
      <div className="flex gap-1 mb-3">
        {(['bg', 'text'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors ${tab === t ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 dark:text-gray-400'}`}>
            {t === 'bg' ? 'Pozadí' : 'Písmo'}
          </button>
        ))}
        <button onClick={() => onChange(tab === 'bg' ? { bgColor: undefined } : { textColor: undefined })}
          title="Odstranit barvu"
          className="px-2 py-1 text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors">
          ×
        </button>
      </div>
      <ColorPicker
        color={tab === 'bg' ? (cell.bgColor ?? '#ffffff') : (cell.textColor ?? '#111827')}
        onChange={hex => onChange(tab === 'bg' ? { bgColor: hex } : { textColor: hex })}
      />
    </div>,
    document.body
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
  const [colorTarget, setColorTarget] = useState<{ rowId: string; colId: string; pos: { x: number; y: number } } | null>(null)
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

  function update(nextData: SpreadsheetData) {
    setData(nextData)
    persist(nextData)
  }

  // ── Name ───────────────────────────────────────────────────

  function commitName() {
    setEditingName(false)
    const trimmed = tableName.trim() || spreadsheet.name
    setTableName(trimmed)
    persist(data, trimmed)
  }

  // ── Columns ────────────────────────────────────────────────

  function addColumn() {
    const id = crypto.randomUUID()
    const next: SpreadsheetData = {
      ...data,
      columns: [...data.columns, { id, name: `Sloupec ${data.columns.length + 1}`, width: 140 }],
    }
    update(next)
  }

  function renameColumn(colId: string, name: string) {
    update({ ...data, columns: data.columns.map(c => c.id === colId ? { ...c, name } : c) })
  }

  function deleteColumn(colId: string) {
    update({
      columns: data.columns.filter(c => c.id !== colId),
      rows: data.rows.map(r => {
        const cells = { ...r.cells }
        delete cells[colId]
        return { ...r, cells }
      }),
    })
  }

  // ── Rows ───────────────────────────────────────────────────

  function addRow() {
    update({ ...data, rows: [...data.rows, { id: crypto.randomUUID(), cells: {} }] })
  }

  function deleteRow(rowId: string) {
    update({ ...data, rows: data.rows.filter(r => r.id !== rowId) })
  }

  // ── Cells ──────────────────────────────────────────────────

  function startEdit(rowId: string, colId: string) {
    const val = data.rows.find(r => r.id === rowId)?.cells[colId]?.value ?? ''
    setEditingCell({ rowId, colId })
    setEditVal(val)
  }

  function commitEdit() {
    if (!editingCell) return
    const { rowId, colId } = editingCell
    update({
      ...data,
      rows: data.rows.map(r => r.id !== rowId ? r : {
        ...r,
        cells: { ...r.cells, [colId]: { ...r.cells[colId], value: editVal } },
      }),
    })
    setEditingCell(null)
  }

  function patchCell(rowId: string, colId: string, patch: Partial<SpreadsheetCell>) {
    update({
      ...data,
      rows: data.rows.map(r => r.id !== rowId ? r : {
        ...r,
        cells: { ...r.cells, [colId]: { ...{ value: '' as string }, ...r.cells[colId], ...patch } },
      }),
    })
  }

  // ── Drag & drop ────────────────────────────────────────────

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleColDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = data.columns.findIndex(c => c.id === active.id)
    const newIdx = data.columns.findIndex(c => c.id === over.id)
    update({ ...data, columns: arrayMove(data.columns, oldIdx, newIdx) })
  }

  function handleRowDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = data.rows.findIndex(r => r.id === active.id)
    const newIdx = data.rows.findIndex(r => r.id === over.id)
    update({ ...data, rows: arrayMove(data.rows, oldIdx, newIdx) })
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
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

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-auto shadow-sm">
        {/* Column headers */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10 bg-gray-50 dark:bg-gray-800/80">
          {/* Corner cell (aligns with row handle) */}
          <div className="w-8 shrink-0 border-r border-gray-200 dark:border-gray-700" />
          {/* Draggable column headers */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleColDragEnd}>
            <SortableContext items={data.columns.map(c => c.id)} strategy={horizontalListSortingStrategy}>
              {data.columns.map(col => (
                <SortableColHeader
                  key={col.id}
                  id={col.id}
                  name={col.name}
                  onRename={renameColumn}
                  onDelete={deleteColumn}
                />
              ))}
            </SortableContext>
          </DndContext>
          {/* Add column */}
          <button
            onClick={addColumn}
            className="flex items-center justify-center w-10 shrink-0 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 dark:hover:text-indigo-400 transition-colors border-l border-gray-200 dark:border-gray-700"
            title="Přidat sloupec"
          >
            <Plus size={15} />
          </button>
        </div>

        {/* Rows */}
        {data.rows.length === 0 && data.columns.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            Přidej sloupce a řádky tlačítky +
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleRowDragEnd}>
            <SortableContext items={data.rows.map(r => r.id)} strategy={verticalListSortingStrategy}>
              {data.rows.map(row => (
                <SortableRow key={row.id} id={row.id}>
                  {data.columns.map(col => {
                    const cell: SpreadsheetCell = row.cells[col.id] ?? { value: '' }
                    const isEditing = editingCell?.rowId === row.id && editingCell?.colId === col.id

                    return (
                      <div
                        key={col.id}
                        className="group/cell relative min-w-[140px] w-[140px] shrink-0 border-r border-gray-100 dark:border-gray-800"
                        style={{ backgroundColor: cell.bgColor, color: cell.textColor }}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editVal}
                            onChange={e => setEditVal(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitEdit()
                              if (e.key === 'Escape') setEditingCell(null)
                            }}
                            className="absolute inset-0 w-full h-full px-2 py-1.5 text-sm bg-white dark:bg-gray-800 border-2 border-indigo-500 outline-none z-10"
                            style={{ color: cell.textColor }}
                          />
                        ) : (
                          <div
                            className="px-2 py-1.5 text-sm min-h-[36px] cursor-text whitespace-pre-wrap break-words"
                            onClick={() => startEdit(row.id, col.id)}
                          >
                            {cell.value}
                          </div>
                        )}
                        {/* Color button */}
                        {!isEditing && (
                          <button
                            onMouseDown={e => {
                              e.preventDefault()
                              setColorTarget({ rowId: row.id, colId: col.id, pos: { x: e.clientX, y: e.clientY + 8 } })
                            }}
                            className="absolute top-0.5 right-0.5 p-0.5 rounded opacity-0 group-hover/cell:opacity-100 transition-opacity text-gray-400 hover:text-indigo-500 bg-white/80 dark:bg-gray-900/80"
                            title="Barva buňky"
                          >
                            <Palette size={11} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {/* Row delete button */}
                  <button
                    onClick={() => deleteRow(row.id)}
                    className="flex items-center justify-center w-10 shrink-0 opacity-0 group-hover/row:opacity-100 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-all border-l border-gray-100 dark:border-gray-800"
                  >
                    <Trash2 size={12} />
                  </button>
                </SortableRow>
              ))}
            </SortableContext>
          </DndContext>
        )}

        {/* Add row */}
        <button
          onClick={addRow}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/10 dark:hover:text-indigo-400 transition-colors border-t border-gray-100 dark:border-gray-800"
        >
          <Plus size={14} /> Přidat řádek
        </button>
      </div>

      {/* Color popover */}
      {colorTarget && (() => {
        const row = data.rows.find(r => r.id === colorTarget.rowId)
        const cell: SpreadsheetCell = row?.cells[colorTarget.colId] ?? { value: '' }
        return (
          <CellColorPopover
            cell={cell}
            pos={colorTarget.pos}
            onClose={() => setColorTarget(null)}
            onChange={patch => patchCell(colorTarget.rowId, colorTarget.colId, patch)}
          />
        )
      })()}
    </div>
  )
}
