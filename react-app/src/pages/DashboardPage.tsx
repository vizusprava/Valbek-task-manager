import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, CheckCircle2, AlertCircle, Clock, MoreHorizontal, BookTemplate } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageLayout } from '@/components/layout/PageLayout'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatDate, isOverdue, isDueSoon } from '@/lib/utils'
import { ManageTaskTemplatesModal } from '@/components/ui/TaskTemplatesModal'
import type { Profile, Project } from '@/lib/types'

type FilterType = 'aktivní' | 'dokončeno' | 'vše'

interface ProjectWithStats extends Project {
  project_members: { user_id: string }[]
  _stats?: { total: number; done: number; review: number; inprog: number; todo: number }
  _members?: Profile[]
}

// ── Project Card ──────────────────────────────────────────────

function ProjectCard({ project, members }: { project: ProjectWithStats; members: Profile[] }) {
  const stats    = project._stats ?? { total: 0, done: 0, review: 0, inprog: 0, todo: 0 }
  const pct      = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0
  const overdue  = isOverdue(project.due_date) && project.status !== 'dokončeno'
  const dueSoon  = !overdue && isDueSoon(project.due_date) && project.status !== 'dokončeno'
  const isDone   = project.status === 'dokončeno'
  const memberIds = project.project_members.map(m => m.user_id)
  const projectMembers = members.filter(m => memberIds.includes(m.id))

  return (
    <Link to={`/project/${project.id}`}
      className={`block rounded-xl border transition-shadow hover:shadow-md p-5 space-y-3
        ${isDone   ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
          : overdue  ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
          : dueSoon  ? 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800'
          : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          {isDone   && <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-emerald-500 dark:text-emerald-400" />}
          {overdue  && <AlertCircle  size={16} className="shrink-0 mt-0.5 text-red-500 dark:text-red-400" />}
          {dueSoon  && <Clock        size={16} className="shrink-0 mt-0.5 text-orange-500 dark:text-orange-400" />}
          <h3 className={`font-semibold text-sm leading-snug
            ${isDone  ? 'text-emerald-800 dark:text-emerald-200'
            : overdue ? 'text-red-800 dark:text-red-200'
            : dueSoon ? 'text-orange-800 dark:text-orange-200'
            : 'text-gray-900 dark:text-gray-100'}`}>{project.name}</h3>
        </div>
        <div className="flex -space-x-1 shrink-0">
          {projectMembers.slice(0, 4).map(m => (
            <Avatar key={m.id} name={m.name} initials={m.initials} color={m.color} small />
          ))}
        </div>
      </div>

      {isDone && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700">✓ Dokončeno</span>}

      {project.description && (
        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{project.description}</p>
      )}

      {project.due_date && (
        <p className={`text-xs font-medium ${overdue ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
          Termín: {formatDate(project.due_date)}
        </p>
      )}

      {/* Stats dots */}
      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-1" title="Neudělano"><span className="w-2 h-2 rounded-full bg-gray-400 inline-block" />{stats.todo}</span>
        <span className="flex items-center gap-1" title="Rozpracováno"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />{stats.inprog}</span>
        <span className="flex items-center gap-1" title="Ke kontrole"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />{stats.review}</span>
        <span className="flex items-center gap-1" title="Hotovo"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />{stats.done}</span>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-gray-400">{pct}% hotovo · {stats.total} úkolů</p>
      </div>
    </Link>
  )
}

// ── Create Project Modal ──────────────────────────────────────

function CreateProjectModal({ open, onClose, profiles }: { open: boolean; onClose: () => void; profiles: Profile[] }) {
  const { profile, isAdmin } = useAuthStore()
  const queryClient = useQueryClient()

  const [name,       setName]       = useState('')
  const [desc,       setDesc]       = useState('')
  const [dueDate,    setDueDate]    = useState('')
  const [filePath,   setFilePath]   = useState('')
  const [memberIds,  setMemberIds]  = useState<string[]>([])
  const [customSubs, setCustomSubs] = useState<string[]>([])
  const [customInput,setCustomInput]= useState('')
  const [tplRef,     setTplRef]     = useState<string[]>([])
  const [tplCustom,  setTplCustom]  = useState<string[]>([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')

  const { data: refItems } = useQuery({
    queryKey: ['ref-items-model-subs'],
    queryFn: async () => {
      const { data } = await supabase.from('reference_items').select('id, code, name, sort_order')
        .eq('page', '3dmax').eq('section', 'model_subs').order('sort_order')
      return data || []
    },
    enabled: open && isAdmin(),
  })

  const { data: tplItems } = useQuery({
    queryKey: ['subproject-templates'],
    queryFn: async () => {
      const { data } = await supabase.from('subproject_templates').select('id, name, sort_order').order('sort_order')
      return data || []
    },
    enabled: open && isAdmin(),
  })

  useEffect(() => {
    if (open && profile) {
      setMemberIds([profile.id])
      setTplCustom(tplItems?.filter(t => t.name === 'Postprodukce').map(t => t.name) || [])
    }
  }, [open, profile, tplItems])

  function reset() {
    setName(''); setDesc(''); setDueDate(''); setFilePath('')
    setMemberIds(profile ? [profile.id] : [])
    setCustomSubs([]); setCustomInput('')
    setTplRef([]); setTplCustom([])
    setError('')
  }

  function handleClose() { reset(); onClose() }

  function toggleMember(id: string) {
    if (id === profile?.id) return
    setMemberIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  function addCustomSub() {
    const n = customInput.trim()
    if (!n) return
    if (customSubs.some(s => s.toLowerCase() === n.toLowerCase())) {
      setError('Tento podprojekt už je v seznamu.'); return
    }
    setCustomSubs(prev => [...prev, n])
    setCustomInput('')
    setError('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    setError('')
    setLoading(true)

    try {
      const { data: proj, error: projErr } = await supabase
        .from('projects')
        .insert({ name: name.trim(), description: desc.trim() || null, due_date: dueDate || null, file_path: filePath.trim() || null, created_by: profile.id })
        .select().single()
      if (projErr) throw projErr

      const finalMembers = memberIds.includes(profile.id) ? memberIds : [...memberIds, profile.id]
      const { error: memErr } = await supabase.from('project_members').insert(finalMembers.map(uid => ({ project_id: proj.id, user_id: uid })))
      if (memErr) throw memErr

      const allSubNames = [...tplRef, ...tplCustom, ...customSubs]
      const seen = new Set<string>()
      const uniqueNames = allSubNames.filter(n => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
      if (uniqueNames.length) {
        const { error: subErr } = await supabase.from('subprojects').insert(
          uniqueNames.map((n, i) => ({ project_id: proj.id, name: n, sort_order: i * 10, created_by: profile.id }))
        )
        if (subErr) throw subErr
      }

      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Projekt vytvořen!')
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chyba.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Nový projekt" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Název projektu *</label>
            <input required value={name} onChange={e => setName(e.target.value)} placeholder="Název projektu"
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Popis</label>
            <textarea rows={2} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Krátký popis projektu…"
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Termín</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cesta k souboru</label>
            <input type="text" value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="\\server\share\projekt"
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
        </div>

        {/* Subproject templates */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Podprojekty</label>

          {refItems && refItems.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Z 3DMax kategorií</p>
              <div className="flex flex-wrap gap-2">
                {refItems.map(r => {
                  const label = (r.code ? r.code + ' ' : '') + r.name
                  const checked = tplRef.includes(label)
                  return (
                    <label key={r.id} className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-600 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                      <input type="checkbox" className="sr-only" checked={checked} onChange={() => setTplRef(prev => prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label])} />
                      {label}
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {tplItems && tplItems.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Vlastní šablony</p>
              <div className="flex flex-wrap gap-2">
                {tplItems.map(t => {
                  const checked = tplCustom.includes(t.name)
                  return (
                    <label key={t.id} className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-600 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                      <input type="checkbox" className="sr-only" checked={checked} onChange={() => setTplCustom(prev => prev.includes(t.name) ? prev.filter(x => x !== t.name) : [...prev, t.name])} />
                      {t.name}
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Vlastní podprojekt</p>
            <div className="flex gap-2">
              <input value={customInput} onChange={e => setCustomInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomSub() } }}
                placeholder="Název podprojektu…"
                className="flex-1 px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <Button type="button" size="sm" onClick={addCustomSub}>+ Přidat</Button>
            </div>
            {customSubs.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {customSubs.map((s, i) => (
                  <span key={i} className="flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2.5 py-1 rounded-full">
                    {s}
                    <button type="button" onClick={() => setCustomSubs(prev => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 ml-0.5">✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Members */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Členové projektu</label>
          <div className="flex flex-wrap gap-2">
            {profiles.map(p => {
              const checked = memberIds.includes(p.id)
              const isMe    = p.id === profile?.id
              return (
                <label key={p.id} className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border cursor-pointer transition-colors ${isMe ? 'bg-indigo-100 border-indigo-300 text-indigo-700 dark:bg-indigo-900/40 dark:border-indigo-600 dark:text-indigo-300 cursor-not-allowed' : checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-600 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                  <input type="checkbox" className="sr-only" checked={checked} disabled={isMe} onChange={() => toggleMember(p.id)} />
                  <Avatar name={p.name} initials={p.initials} color={p.color} small />
                  {p.name}
                  {p.role === 'admin' && <span className="text-indigo-400 ml-0.5">admin</span>}
                </label>
              )
            })}
          </div>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button type="button" variant="secondary" onClick={handleClose}>Zrušit</Button>
          <Button type="submit" variant="primary" loading={loading}>Vytvořit projekt</Button>
        </div>
      </form>
    </Modal>
  )
}

// ── Dashboard Page ────────────────────────────────────────────

export function DashboardPage() {
  const { isAdmin } = useAuthStore()
  const queryClient  = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter,  setFilter]  = useState<FilterType>('aktivní')
  const [search,  setSearch]  = useState('')
  const [showCreate,    setShowCreate]    = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showAdminMenu, setShowAdminMenu] = useState(false)
  const adminMenuRef = useRef<HTMLDivElement>(null)

  const admin = isAdmin()

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
    if (searchParams.has('new')) {
      setShowCreate(true)
      setSearchParams({})
    }
  }, [searchParams, setSearchParams])

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('*').order('name')
      return (data || []) as Profile[]
    },
  })

  const { data: projects = [], isLoading } = useQuery<ProjectWithStats[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const { data } = await supabase
        .from('projects')
        .select('id, name, description, status, due_date, created_at, created_by, file_path, project_members(user_id)')
        .order('created_at', { ascending: false })
      return (data || []) as ProjectWithStats[]
    },
  })

  const { data: taskStats } = useQuery({
    queryKey: ['projects-task-stats', projects.map(p => p.id)],
    queryFn: async () => {
      if (!projects.length) return {}
      const { data } = await supabase.from('tasks').select('project_id, status').in('project_id', projects.map(p => p.id))
      const byProject: Record<string, { total: number; done: number; review: number; inprog: number; todo: number }> = {}
      for (const t of data || []) {
        if (!byProject[t.project_id]) byProject[t.project_id] = { total: 0, done: 0, review: 0, inprog: 0, todo: 0 }
        byProject[t.project_id].total++
        if (t.status === 'hotovo' || t.status === 'schváleno') byProject[t.project_id].done++
        else if (t.status === 'připraveno ke kontrole') byProject[t.project_id].review++
        else if (t.status === 'rozpracováno') byProject[t.project_id].inprog++
        else byProject[t.project_id].todo++
      }
      return byProject
    },
    enabled: projects.length > 0,
  })

  // Realtime subscription
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['projects'] })
    queryClient.invalidateQueries({ queryKey: ['projects-task-stats'] })
  }, [queryClient])

  useEffect(() => {
    const channel = supabase.channel('dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_members' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, invalidate)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [invalidate])

  const filtered = useMemo(() => {
    let result = filter === 'vše' ? projects : projects.filter(p => p.status === filter)
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q))
    }
    return result.map(p => ({ ...p, _stats: taskStats?.[p.id] }))
  }, [projects, filter, search, taskStats])

  const FILTERS: { value: FilterType; label: string }[] = [
    { value: 'aktivní',   label: 'Aktivní' },
    { value: 'dokončeno', label: 'Dokončené' },
    { value: 'vše',       label: 'Vše' },
  ]

  return (
    <PageLayout>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Projekty</h1>
        {admin && (
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={16} />Nový projekt
            </Button>
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
                <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-30 min-w-45 overflow-hidden py-1">
                  <button onClick={() => { setShowTemplates(true); setShowAdminMenu(false) }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2.5">
                    <BookTemplate size={14} className="text-gray-400" /> Šablony úkolů
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
          {FILTERS.map(f => (
            <button key={f.value} onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${filter === f.value ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Hledat projekty…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 sm:max-w-xs px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          {filter === 'dokončeno' ? 'Žádné dokončené projekty.' :
           filter === 'aktivní' ? (admin ? 'Žádné aktivní projekty. Vytvořte první.' : 'Žádné aktivní projekty.') :
           'Žádné projekty.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(p => (
            <ProjectCard key={p.id} project={p} members={profiles} />
          ))}
          {admin && (
            <button onClick={() => setShowCreate(true)}
              className="flex flex-col items-center justify-center gap-2 bg-white dark:bg-gray-900 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-6 text-gray-400 hover:border-indigo-300 hover:text-indigo-400 dark:hover:border-indigo-700 dark:hover:text-indigo-400 transition-colors min-h-40">
              <Plus size={28} />
              <span className="text-sm font-medium">Nový projekt</span>
            </button>
          )}
        </div>
      )}

      <CreateProjectModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        profiles={profiles}
      />
      <ManageTaskTemplatesModal open={showTemplates} onClose={() => setShowTemplates(false)} />
    </PageLayout>
  )
}
