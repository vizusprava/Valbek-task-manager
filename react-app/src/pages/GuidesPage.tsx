import { useState, useEffect, useRef, Fragment } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Plus, Pencil, Trash2, ChevronUp, ChevronDown, Check, X, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageLayout } from '@/components/layout/PageLayout'
import { useConfirm } from '@/components/ui/ConfirmDialog'

interface Guide {
  id: string
  title: string
  description: string | null
  sort_order: number
  created_by: string | null
  created_at: string
}

interface GuideItem {
  id: string
  guide_id: string
  text: string
  sort_order: number
  created_by: string | null
}

const inputClass = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500'

// *text* → tučně (např. *V:*)
function RichText({ text }: { text: string }) {
  const parts = text.split(/\*([^*]+)\*/g)
  return <>{parts.map((p, i) => i % 2 ? <strong key={i} className="font-semibold">{p}</strong> : <Fragment key={i}>{p}</Fragment>)}</>
}

// Odškrtnuté body jsou jen osobní pomůcka — drží se v prohlížeči, do DB se neukládají.
// GuideDetail má key={guide.id}, takže se při přepnutí návodu stav načte znovu.
function useChecks(guideId: string) {
  const key = `guide-checks:${guideId}`
  const [checked, setChecked] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]') } catch { return [] }
  })

  function save(next: string[]) {
    setChecked(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* ignore */ }
  }

  return {
    checked,
    toggle: (id: string) => save(checked.includes(id) ? checked.filter(x => x !== id) : [...checked, id]),
    reset: () => save([]),
  }
}

function ItemRow({ item, index, count, checked, onToggle, onMove }: {
  item: GuideItem
  index: number
  count: number
  checked: boolean
  onToggle: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)

  function startEdit() {
    setText(item.text)
    setEditing(true)
  }

  async function handleSave() {
    const t = text.trim()
    if (!t) return
    if (t === item.text) { setEditing(false); return }
    const { error } = await supabase.from('guide_items')
      .update({ text: t, updated_at: new Date().toISOString() }).eq('id', item.id)
    if (error) { toast.error('Nepodařilo se uložit bod'); return }
    setEditing(false)
    qc.invalidateQueries({ queryKey: ['guide-items'] })
  }

  async function handleDelete() {
    const ok = await confirm({ title: 'Smazat bod', message: `Opravdu smazat bod „${item.text}“?`, confirmLabel: 'Smazat', variant: 'danger' })
    if (!ok) return
    const { error } = await supabase.from('guide_items').delete().eq('id', item.id)
    if (error) { toast.error('Nepodařilo se smazat bod'); return }
    qc.invalidateQueries({ queryKey: ['guide-items'] })
  }

  if (editing) {
    return (
      <li className="flex items-start gap-2 px-3 py-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave() }
            if (e.key === 'Escape') setEditing(false)
          }}
          rows={2}
          autoFocus
          className={`${inputClass} resize-none`}
        />
        <button onClick={handleSave} title="Uložit"
          className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"><Check size={14} /></button>
        <button onClick={() => setEditing(false)} title="Zrušit"
          className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={14} /></button>
      </li>
    )
  }

  return (
    <li className="group flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50">
      <button onClick={onToggle}
        className={`mt-0.5 w-5 h-5 shrink-0 rounded border-2 flex items-center justify-center transition-colors
          ${checked ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-300 dark:border-gray-600 hover:border-indigo-500'}`}>
        {checked && <Check size={13} strokeWidth={3} />}
      </button>
      <p onClick={onToggle}
        className={`flex-1 text-sm leading-relaxed cursor-pointer select-none ${checked ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}`}>
        <RichText text={item.text} />
      </p>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button onClick={() => onMove(-1)} disabled={index === 0} title="Posunout nahoru"
          className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30"><ChevronUp size={14} /></button>
        <button onClick={() => onMove(1)} disabled={index === count - 1} title="Posunout dolů"
          className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30"><ChevronDown size={14} /></button>
        <button onClick={startEdit} title="Upravit"
          className="p-1 rounded text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400"><Pencil size={14} /></button>
        <button onClick={handleDelete} title="Smazat"
          className="p-1 rounded text-gray-400 hover:text-red-500 dark:hover:text-red-400"><Trash2 size={14} /></button>
      </div>
    </li>
  )
}

function GuideDetail({ guide, items }: { guide: Guide; items: GuideItem[] }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { user, isAdmin } = useAuthStore()
  const { checked, toggle, reset } = useChecks(guide.id)
  const [newText, setNewText] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingHead, setEditingHead] = useState(false)
  const [title, setTitle] = useState(guide.title)
  const [description, setDescription] = useState(guide.description ?? '')
  const newInputRef = useRef<HTMLInputElement>(null)

  function startEditHead() {
    setTitle(guide.title)
    setDescription(guide.description ?? '')
    setEditingHead(true)
  }

  const doneCount = items.filter(i => checked.includes(i.id)).length
  const canDelete = isAdmin() || guide.created_by === user?.id

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const t = newText.trim()
    if (!t || !user) return
    setAdding(true)
    const sortOrder = items.length ? Math.max(...items.map(i => i.sort_order)) + 1 : 0
    const { error } = await supabase.from('guide_items').insert({ guide_id: guide.id, text: t, sort_order: sortOrder, created_by: user.id })
    setAdding(false)
    if (error) { toast.error('Nepodařilo se přidat bod'); return }
    setNewText('')
    newInputRef.current?.focus()
    qc.invalidateQueries({ queryKey: ['guide-items'] })
  }

  async function handleMove(index: number, dir: -1 | 1) {
    const target = index + dir
    if (target < 0 || target >= items.length) return
    // pořadí může mít mezery/duplicity (mazání, souběžné přidání) — přečíslovat celý seznam 0..n
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    const results = await Promise.all(next
      .map((it, i) => ({ it, i }))
      .filter(({ it, i }) => it.sort_order !== i)
      .map(({ it, i }) => supabase.from('guide_items').update({ sort_order: i }).eq('id', it.id)))
    if (results.some(r => r.error)) toast.error('Nepodařilo se změnit pořadí')
    qc.invalidateQueries({ queryKey: ['guide-items'] })
  }

  async function handleSaveHead() {
    const t = title.trim()
    if (!t) return
    const { error } = await supabase.from('guides').update({ title: t, description: description.trim() || null }).eq('id', guide.id)
    if (error) { toast.error('Nepodařilo se uložit návod'); return }
    setEditingHead(false)
    qc.invalidateQueries({ queryKey: ['guides'] })
  }

  async function handleDeleteGuide() {
    const ok = await confirm({ title: 'Smazat návod', message: `Opravdu smazat celý návod „${guide.title}“ včetně všech bodů?`, confirmLabel: 'Smazat', variant: 'danger' })
    if (!ok) return
    const { error } = await supabase.from('guides').delete().eq('id', guide.id)
    if (error) { toast.error('Nepodařilo se smazat návod'); return }
    toast.success('Návod smazán')
    qc.invalidateQueries({ queryKey: ['guides'] })
    qc.invalidateQueries({ queryKey: ['guide-items'] })
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm">
      {/* Hlavička */}
      <div className="p-5 border-b border-gray-100 dark:border-gray-800">
        {editingHead ? (
          <div className="space-y-2">
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Název návodu" autoFocus className={inputClass} />
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Krátký popis (volitelný)" className={inputClass} />
            <div className="flex gap-2">
              <button onClick={handleSaveHead} disabled={!title.trim()}
                className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 font-medium">Uložit</button>
              <button onClick={() => setEditingHead(false)}
                className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">Zrušit</button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{guide.title}</h2>
              {guide.description && <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{guide.description}</p>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={startEditHead} title="Upravit název"
                className="p-1.5 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-gray-100 dark:hover:text-indigo-400 dark:hover:bg-gray-800"><Pencil size={15} /></button>
              {canDelete && (
                <button onClick={handleDeleteGuide} title="Smazat návod"
                  className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"><Trash2 size={15} /></button>
              )}
            </div>
          </div>
        )}

        {items.length > 0 && (
          <div className="mt-4 flex items-center gap-3">
            <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
              <div className="h-full bg-indigo-600 transition-all" style={{ width: `${(doneCount / items.length) * 100}%` }} />
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{doneCount} / {items.length}</span>
            {doneCount > 0 && (
              <button onClick={reset} title="Odškrtat vše"
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                <RotateCcw size={12} /> Znovu
              </button>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-2">
        {items.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">Návod zatím nemá žádné body.</p>
        ) : (
          <ul>
            {items.map((item, i) => (
              <ItemRow key={item.id} item={item} index={i} count={items.length}
                checked={checked.includes(item.id)} onToggle={() => toggle(item.id)} onMove={dir => handleMove(i, dir)} />
            ))}
          </ul>
        )}

        <form onSubmit={handleAdd} className="flex items-center gap-2 px-3 pt-2 pb-3">
          <input ref={newInputRef} value={newText} onChange={e => setNewText(e.target.value)}
            placeholder="Doplnit bod… (*text* = tučně)" className={inputClass} />
          <button type="submit" disabled={adding || !newText.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 shrink-0">
            <Plus size={15} /> Přidat
          </button>
        </form>
      </div>
    </div>
  )
}

export function GuidesPage() {
  const qc = useQueryClient()
  const { user } = useAuthStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const { data: guides = [], isLoading } = useQuery({
    queryKey: ['guides'],
    queryFn: async () => {
      const { data, error } = await supabase.from('guides').select('*')
        .order('sort_order').order('created_at')
      if (error) throw new Error(error.message)
      return (data ?? []) as Guide[]
    },
  })

  const { data: allItems = [] } = useQuery({
    queryKey: ['guide-items'],
    queryFn: async () => {
      const { data, error } = await supabase.from('guide_items').select('*')
        .order('sort_order').order('created_at')
      if (error) throw new Error(error.message)
      return (data ?? []) as GuideItem[]
    },
  })

  useEffect(() => {
    const ch = supabase.channel('guides-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guides' }, () => qc.invalidateQueries({ queryKey: ['guides'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guide_items' }, () => qc.invalidateQueries({ queryKey: ['guide-items'] }))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [qc])

  const selected = guides.find(g => g.id === selectedId) ?? guides[0] ?? null

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const t = newTitle.trim()
    if (!t || !user) return
    const sortOrder = guides.length ? Math.max(...guides.map(g => g.sort_order)) + 1 : 0
    const { data, error } = await supabase.from('guides')
      .insert({ title: t, sort_order: sortOrder, created_by: user.id }).select('id').single()
    if (error) { toast.error('Nepodařilo se vytvořit návod'); return }
    setNewTitle('')
    setCreating(false)
    setSelectedId(data.id)
    qc.invalidateQueries({ queryKey: ['guides'] })
  }

  return (
    <PageLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Návody</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Postupy a kontrolní seznamy — kdokoli může body doplnit, uloží se všem</p>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-[16rem_1fr] items-start">
            {/* Seznam návodů */}
            <div className="space-y-1">
              {guides.map(g => {
                const count = allItems.filter(i => i.guide_id === g.id).length
                const active = selected?.id === g.id
                return (
                  <button key={g.id} onClick={() => setSelectedId(g.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-left transition-colors
                      ${active
                        ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 font-medium'
                        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}>
                    <BookOpen size={15} className="shrink-0" />
                    <span className="flex-1 truncate">{g.title}</span>
                    <span className="text-xs text-gray-400 tabular-nums">{count}</span>
                  </button>
                )
              })}

              {creating ? (
                <form onSubmit={handleCreate} className="space-y-2 pt-1">
                  <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Název návodu"
                    autoFocus onKeyDown={e => { if (e.key === 'Escape') setCreating(false) }} className={inputClass} />
                  <div className="flex gap-2">
                    <button type="submit" disabled={!newTitle.trim()}
                      className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 font-medium">Vytvořit</button>
                    <button type="button" onClick={() => setCreating(false)}
                      className="px-3 py-1.5 text-sm rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">Zrušit</button>
                  </div>
                </form>
              ) : (
                <button onClick={() => setCreating(true)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-gray-500 hover:text-indigo-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-indigo-400 dark:hover:bg-gray-800 border border-dashed border-gray-200 dark:border-gray-700">
                  <Plus size={15} /> Nový návod
                </button>
              )}
            </div>

            {/* Detail */}
            {selected ? (
              <GuideDetail key={selected.id} guide={selected} items={allItems.filter(i => i.guide_id === selected.id)} />
            ) : (
              <div className="text-center py-16 text-gray-400">
                <BookOpen size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">Zatím žádné návody. Vytvoř první vlevo.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </PageLayout>
  )
}
