import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Clock, AlertCircle, FolderOpen, TrendingUp, type LucideIcon } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageLayout } from '@/components/layout/PageLayout'
import { Avatar } from '@/components/ui/Avatar'
import { PriorityBadge } from '@/components/ui/Badge'
import type { Task, Project, Profile, Subproject } from '@/lib/types'

// ── Types ─────────────────────────────────────────────────────

interface ProjectWithMembers extends Project {
  project_members: { user_id: string; profiles: Pick<Profile, 'id' | 'name' | 'initials' | 'color'> }[]
}

// ── Helpers ───────────────────────────────────────────────────

const STATUS_ORDER = ['neudělano', 'rozpracováno', 'připraveno ke kontrole', 'schváleno', 'hotovo'] as const
const STATUS_LABELS: Record<string, string> = {
  'neudělano': 'Neudělano',
  'rozpracováno': 'Rozpracováno',
  'připraveno ke kontrole': 'Ke kontrole',
  'schváleno': 'Schváleno',
  'hotovo': 'Hotovo',
}
const STATUS_COLORS: Record<string, string> = {
  'neudělano': 'bg-gray-400',
  'rozpracováno': 'bg-blue-500',
  'připraveno ke kontrole': 'bg-yellow-500',
  'schváleno': 'bg-teal-500',
  'hotovo': 'bg-green-500',
}

function isOverdue(task: Task) {
  return task.due_date && task.status !== 'hotovo' && task.status !== 'schváleno' && new Date(task.due_date) < new Date()
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Stat card ─────────────────────────────────────────────────

function StatCard({ label, value, sub, Icon, color }: {
  label: string; value: string | number; sub?: string
  Icon: LucideIcon; color: string
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 flex items-start gap-4">
      <div className={`p-2.5 rounded-lg ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
        {sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

// ── Status bar ────────────────────────────────────────────────

function StatusBar({ tasks }: { tasks: Task[] }) {
  const total = tasks.length
  if (total === 0) return null

  const counts = STATUS_ORDER.map(s => ({ status: s, count: tasks.filter(t => t.status === s).length }))

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">Rozdělení podle stavu</h3>
      <div className="flex h-4 rounded-full overflow-hidden gap-px">
        {counts.map(({ status, count }) =>
          count === 0 ? null : (
            <div
              key={status}
              className={`${STATUS_COLORS[status]} transition-all`}
              style={{ width: `${(count / total) * 100}%` }}
              title={`${STATUS_LABELS[status]}: ${count}`}
            />
          )
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3">
        {counts.map(({ status, count }) => (
          <div key={status} className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[status]}`} />
            <span className="text-xs text-gray-600 dark:text-gray-400">{STATUS_LABELS[status]}</span>
            <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{count}</span>
            <span className="text-xs text-gray-400">({Math.round((count / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Project card ──────────────────────────────────────────────

function ProjectCard({ project, tasks }: { project: ProjectWithMembers; tasks: Task[] }) {
  const total = tasks.length
  const done  = tasks.filter(t => (t.status === 'hotovo' || t.status === 'schváleno')).length
  const overdue = tasks.filter(isOverdue).length
  const pct   = total === 0 ? 0 : Math.round((done / total) * 100)

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">{project.name}</h3>
          {project.due_date && (
            <p className="text-xs text-gray-400 mt-0.5">Termín: {formatDate(project.due_date)}</p>
          )}
        </div>
        <span className={`shrink-0 text-xs font-semibold px-2 py-1 rounded-full ${
          project.status === 'aktivní'
            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            : project.status === 'dokončeno'
            ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
            : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
        }`}>
          {project.status === 'aktivní' ? 'Aktivní' : project.status === 'dokončeno' ? 'Dokončen' : project.status}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
          <span>Dokončeno</span>
          <span className="font-semibold text-gray-700 dark:text-gray-300">{pct}%</span>
        </div>
        <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-green-500' : 'bg-indigo-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        <span><span className="font-semibold text-gray-700 dark:text-gray-300">{total}</span> úkolů</span>
        <span><span className="font-semibold text-green-600 dark:text-green-400">{done}</span> hotovo</span>
        {overdue > 0 && (
          <span className="text-red-500 dark:text-red-400 font-medium">{overdue} po termínu</span>
        )}
      </div>

      {/* Members */}
      {project.project_members.length > 0 && (
        <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <div className="flex -space-x-1.5">
            {project.project_members.slice(0, 5).map(m => (
              <Avatar key={m.user_id} name={m.profiles.name} initials={m.profiles.initials ?? undefined}
                color={m.profiles.color ?? undefined} small />
            ))}
          </div>
          {project.project_members.length > 5 && (
            <span className="text-xs text-gray-400">+{project.project_members.length - 5}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Per-person table (admin only) ─────────────────────────────

function PersonTable({ tasks, profiles }: { tasks: Task[]; profiles: Profile[] }) {
  const rows = useMemo(() => {
    return profiles.map(p => {
      const mine = tasks.filter(t => t.assigned_to === p.id)
      return {
        profile: p,
        total: mine.length,
        done: mine.filter(t => (t.status === 'hotovo' || t.status === 'schváleno')).length,
        inProgress: mine.filter(t => t.status === 'rozpracováno').length,
        overdue: mine.filter(isOverdue).length,
        highPriority: mine.filter(t => t.priority === 'high' && t.status !== 'hotovo').length,
      }
    }).filter(r => r.total > 0).sort((a, b) => b.total - a.total)
  }, [tasks, profiles])

  if (rows.length === 0) return <p className="text-sm text-gray-400 text-center py-6">Žádná data.</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            <th className="text-left pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Osoba</th>
            <th className="text-center pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Celkem</th>
            <th className="text-center pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Hotovo</th>
            <th className="text-center pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Rozprac.</th>
            <th className="text-center pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Po term.</th>
            <th className="text-center pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Priorita H</th>
            <th className="text-right pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">% hotovo</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
          {rows.map(r => {
            const pct = r.total === 0 ? 0 : Math.round((r.done / r.total) * 100)
            return (
              <tr key={r.profile.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                <td className="py-2.5 pr-4">
                  <div className="flex items-center gap-2">
                    <Avatar name={r.profile.name} initials={r.profile.initials ?? undefined}
                      color={r.profile.color ?? undefined} small />
                    <span className="font-medium text-gray-800 dark:text-gray-200">{r.profile.name}</span>
                  </div>
                </td>
                <td className="py-2.5 text-center font-semibold text-gray-700 dark:text-gray-300">{r.total}</td>
                <td className="py-2.5 text-center text-green-600 dark:text-green-400 font-semibold">{r.done}</td>
                <td className="py-2.5 text-center text-blue-600 dark:text-blue-400">{r.inProgress}</td>
                <td className="py-2.5 text-center">
                  {r.overdue > 0
                    ? <span className="text-red-500 font-semibold">{r.overdue}</span>
                    : <span className="text-gray-300 dark:text-gray-600">—</span>}
                </td>
                <td className="py-2.5 text-center">
                  {r.highPriority > 0
                    ? <span className="inline-flex items-center gap-1"><PriorityBadge priority="high" /><span className="text-xs">{r.highPriority}</span></span>
                    : <span className="text-gray-300 dark:text-gray-600">—</span>}
                </td>
                <td className="py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${pct === 100 ? 'bg-green-500' : 'bg-indigo-500'}`}
                        style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 w-8 text-right">{pct}%</span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Person × Category (subproject name) matrix ───────────────

function PersonCategoryMatrix({ tasks, subprojects, profiles }: {
  tasks: Task[]; subprojects: Subproject[]; profiles: Profile[]
}) {
  // Map subproject_id → name
  const spMap = useMemo(() =>
    Object.fromEntries(subprojects.map(s => [s.id, s.name]))
  , [subprojects])

  // Unique category names that have at least one task, sorted
  const categories = useMemo(() => {
    const names = new Set<string>()
    tasks.forEach(t => { if (t.subproject_id && spMap[t.subproject_id]) names.add(spMap[t.subproject_id]) })
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'cs'))
  }, [tasks, spMap])

  // People with at least one task in any category
  const activeProfiles = useMemo(() =>
    profiles.filter(p => tasks.some(t => t.assigned_to === p.id && t.subproject_id))
  , [tasks, profiles])

  if (categories.length === 0 || activeProfiles.length === 0) return (
    <p className="text-sm text-gray-400 text-center py-6">Žádná data — úkoly nemají přiřazené kategorie.</p>
  )

  return (
    <div className="overflow-x-auto">
      <table className="text-sm min-w-full table-fixed">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            <th className="text-left pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide pr-4 sticky left-0 bg-white dark:bg-gray-900 z-10 w-36">Osoba</th>
            {categories.map(cat => (
              <th key={cat} className="text-center pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide px-2 w-20">
                <span className="block truncate" title={cat}>{cat}</span>
              </th>
            ))}
            <th className="text-center pb-2 text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide pl-3 border-l border-gray-100 dark:border-gray-800 w-16">Celkem</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
          {activeProfiles.map(p => {
            const allMine = tasks.filter(t => t.assigned_to === p.id)
            const catMine = allMine.filter(t => t.subproject_id)
            const totalDone = catMine.filter(t => (t.status === 'hotovo' || t.status === 'schváleno')).length
            return (
              <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                <td className="py-2.5 pr-4 sticky left-0 bg-white dark:bg-gray-900 group-hover:bg-gray-50 z-10">
                  <div className="flex items-center gap-2">
                    <Avatar name={p.name} initials={p.initials ?? undefined} color={p.color ?? undefined} small />
                    <span className="font-medium text-gray-800 dark:text-gray-200 truncate max-w-[80px]">{p.name}</span>
                  </div>
                </td>
                {categories.map(cat => {
                  const sameNameIds = subprojects.filter(s => s.name === cat).map(s => s.id)
                  const allCatTasks = tasks.filter(t => t.assigned_to === p.id && t.subproject_id && sameNameIds.includes(t.subproject_id))
                  const done = allCatTasks.filter(t => (t.status === 'hotovo' || t.status === 'schváleno')).length
                  if (allCatTasks.length === 0) return (
                    <td key={cat} className="py-2.5 px-3 text-center text-gray-300 dark:text-gray-700 text-xs">—</td>
                  )
                  const pct = Math.round((done / allCatTasks.length) * 100)
                  return (
                    <td key={cat} className="py-2.5 px-3 text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        <span className={`text-xs font-semibold ${pct === 100 ? 'text-green-600 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}>
                          {done}/{allCatTasks.length}
                        </span>
                        <div className="w-10 h-1 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${pct === 100 ? 'bg-green-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </td>
                  )
                })}
                <td className="py-2.5 pl-3 border-l border-gray-100 dark:border-gray-800 text-center">
                  <span className="text-xs font-bold text-gray-700 dark:text-gray-300">{totalDone}/{catMine.length}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────

export function ReportsPage() {
  const isAdmin = useAuthStore(s => s.isAdmin())

  const { data: allTasks = [] } = useQuery<Task[]>({
    queryKey: ['reports-tasks'],
    queryFn: async () => {
      const { data } = await supabase.from('tasks').select('*')
      return (data || []) as Task[]
    },
  })

  const { data: projects = [] } = useQuery<ProjectWithMembers[]>({
    queryKey: ['reports-projects'],
    queryFn: async () => {
      const { data } = await supabase
        .from('projects')
        .select('*, project_members(user_id, profiles(id, name, initials, color))')
        .order('name')
      return (data || []) as ProjectWithMembers[]
    },
  })

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['reports-profiles'],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('*').order('name')
      return (data || []) as Profile[]
    },
    enabled: isAdmin,
  })

  const { data: subprojects = [] } = useQuery<Subproject[]>({
    queryKey: ['reports-subprojects'],
    queryFn: async () => {
      const { data } = await supabase.from('subprojects').select('*')
      return (data || []) as Subproject[]
    },
    enabled: isAdmin,
  })

  // Overall stats
  const totalTasks  = allTasks.length
  const doneTasks   = allTasks.filter(t => (t.status === 'hotovo' || t.status === 'schváleno')).length
  const overdueTasks = allTasks.filter(isOverdue).length
  const activeProjects = projects.filter(p => p.status === 'aktivní').length
  const donePct = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100)

  const activeProjectsSorted = projects
    .filter(p => p.status === 'aktivní')
    .sort((a, b) => {
      // Sort by due_date asc (null last), then name
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date)
      if (a.due_date) return -1
      if (b.due_date) return 1
      return a.name.localeCompare(b.name)
    })

  return (
    <PageLayout>
      <div className="max-w-5xl mx-auto space-y-8">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Reporty</h1>

        {/* Top stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Celkem úkolů" value={totalTasks} Icon={TrendingUp} color="bg-indigo-500" />
          <StatCard label="Dokončeno" value={`${donePct}%`} sub={`${doneTasks} z ${totalTasks}`} Icon={CheckCircle2} color="bg-green-500" />
          <StatCard label="Po termínu" value={overdueTasks} Icon={AlertCircle} color={overdueTasks > 0 ? 'bg-red-500' : 'bg-gray-400'} />
          <StatCard label="Aktivní projekty" value={activeProjects} Icon={FolderOpen} color="bg-blue-500" />
        </div>

        {/* Status distribution */}
        <StatusBar tasks={allTasks} />

        {/* Active projects */}
        <section>
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-3 flex items-center gap-2">
            <Clock size={16} className="text-indigo-500" /> Aktivní projekty
          </h2>
          {activeProjectsSorted.length === 0 ? (
            <p className="text-sm text-gray-400">Žádné aktivní projekty.</p>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {activeProjectsSorted.map(p => (
                <ProjectCard key={p.id} project={p}
                  tasks={allTasks.filter(t => t.project_id === p.id)} />
              ))}
            </div>
          )}
        </section>


        {/* Per person (admin only) */}
        {isAdmin && (
          <>
            <section>
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-3">Přehled podle osoby</h2>
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
                <PersonTable tasks={allTasks} profiles={profiles} />
              </div>
            </section>

            <section>
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-3">Modely podle kategorie</h2>
              <p className="text-xs text-gray-400 dark:text-gray-500 -mt-2 mb-3">Hotovo / celkem úkolů na osobu v každé kategorii (přes všechny projekty)</p>
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
                <PersonCategoryMatrix tasks={allTasks} subprojects={subprojects} profiles={profiles} />
              </div>
            </section>
          </>
        )}
      </div>
    </PageLayout>
  )
}
