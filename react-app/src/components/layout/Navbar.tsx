import { useState, useEffect, useRef } from 'react'
import logoUrl from '@/assets/logo.png'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, ListTodo, Box, ClipboardCheck, BarChart2,
  Bell, Sun, Moon, Menu, X, LogOut, Plus, Users, BookTemplate,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import { Avatar } from '@/components/ui/Avatar'
import { ProfileModal } from '@/components/layout/ProfileModal'
import { formatDateTime } from '@/lib/utils'
import type { Notification } from '@/lib/types'

interface NavbarProps {
  onCreateProject?: () => void
  onCreateUser?: () => void
  onManageTemplates?: () => void
}

export function Navbar({ onCreateProject, onCreateUser, onManageTemplates }: NavbarProps) {
  const location  = useLocation()
  const navigate  = useNavigate()
  const { profile, logout, isAdmin } = useAuthStore()
  const admin = isAdmin()

  const [dark,        setDark]        = useState(() => document.documentElement.classList.contains('dark'))
  const [mobileOpen,  setMobileOpen]  = useState(false)
  const [notifOpen,   setNotifOpen]   = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [notifs,      setNotifs]      = useState<Notification[]>([])
  const [reviewCount, setReviewCount] = useState(0)
  const notifRef = useRef<HTMLDivElement>(null)

  const unreadCount = notifs.filter(n => !n.is_read).length

  function toggleDark() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  async function loadNotifs() {
    if (!profile) return
    const { data } = await supabase.from('notifications').select('*')
      .eq('user_id', profile.id).order('created_at', { ascending: false }).limit(30)
    setNotifs((data as Notification[]) || [])
  }

  async function markAllRead() {
    if (!profile) return
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', profile.id).eq('is_read', false)
    setNotifs(prev => prev.map(n => ({ ...n, is_read: true })))
  }

  async function openNotif(n: Notification) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', n.id)
    setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, is_read: true } : x))
    setNotifOpen(false)
    if (n.project_id) navigate(`/project/${n.project_id}`)
  }

  useEffect(() => {
    loadNotifs()
    const ch = supabase.channel('notif-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${profile?.id}` }, () => loadNotifs())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [profile?.id])

  useEffect(() => {
    if (!admin) return
    const load = async () => {
      const { count } = await supabase.from('tasks').select('*', { count: 'exact', head: true }).eq('status', 'připraveno ke kontrole')
      setReviewCount(count || 0)
    }
    load()
    const ch = supabase.channel('review-badge').on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [admin])

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false)
    }
    if (notifOpen) document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [notifOpen])

  // Close mobile sidebar on navigation
  useEffect(() => { setMobileOpen(false) }, [location.pathname])

  const isActive = (to: string) => location.pathname === to || (to === '/dashboard' && location.pathname === '/')

  const navItem = (to: string, label: string, Icon: React.ElementType, badge?: number) => (
    <Link to={to}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors relative group
        ${isActive(to)
          ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800'}`}>
      <Icon size={17} className="shrink-0" />
      {label}
      {!!badge && badge > 0 && (
        <span className="ml-auto min-w-[20px] h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center px-1">
          {badge}
        </span>
      )}
    </Link>
  )

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <Link to="/dashboard" className="flex items-center gap-2.5 px-4 py-5 shrink-0">
        <img src={logoUrl} alt="Valbek" className="h-7 w-auto" />
        <span className="text-sm font-bold tracking-widest text-gray-800 dark:text-gray-100 uppercase">Vizualizace</span>
      </Link>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {navItem('/dashboard',  'Projekty',      LayoutDashboard)}
        {navItem('/my-tasks',   'Moje úkoly',    ListTodo)}
        {navItem('/3dmax',      '3DMax',          Box)}
        {admin && navItem('/review',  'Ke kontrole', ClipboardCheck, reviewCount)}
        {navItem('/reports',    'Reporty',        BarChart2)}

        {/* Admin akce */}
        {admin && (
          <div className="pt-4 mt-2 border-t border-gray-100 dark:border-gray-800 space-y-0.5">
            <p className="px-3 pb-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Správa</p>
            {onCreateProject && (
              <button onClick={onCreateProject}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
                <Plus size={17} className="shrink-0" /> Nový projekt
              </button>
            )}
            {onCreateUser && (
              <button onClick={onCreateUser}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
                <Users size={17} className="shrink-0" /> Nový uživatel
              </button>
            )}
            {onManageTemplates && (
              <button onClick={onManageTemplates}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
                <BookTemplate size={17} className="shrink-0" /> Šablony
              </button>
            )}
          </div>
        )}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 pt-2 border-t border-gray-100 dark:border-gray-800 space-y-0.5 shrink-0">
        {/* Dark mode */}
        <button onClick={toggleDark}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
          {dark ? <Sun size={17} className="shrink-0" /> : <Moon size={17} className="shrink-0" />}
          {dark ? 'Světlý režim' : 'Tmavý režim'}
        </button>

        {/* Notifications */}
        <div className="relative" ref={notifRef}>
          <button onClick={() => { setNotifOpen(o => !o); if (!notifOpen) loadNotifs() }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
            <Bell size={17} className="shrink-0" />
            Upozornění
            {unreadCount > 0 && (
              <span className="ml-auto min-w-[20px] h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center px-1">
                {unreadCount}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute bottom-full left-0 mb-1 w-80 bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden z-50">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Upozornění</span>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} className="text-xs text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">Označit vše přečtené</button>
                )}
              </div>
              <div className="max-h-72 overflow-y-auto">
                {notifs.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">Žádná upozornění.</p>
                ) : notifs.map(n => (
                  <button key={n.id} onClick={() => openNotif(n)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-50 dark:border-gray-800 last:border-0 ${!n.is_read ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''}`}>
                    <p className={`text-sm ${!n.is_read ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'}`}>{n.message}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(n.created_at)}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Profile */}
        {profile && (
          <button onClick={() => setProfileOpen(true)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
            <Avatar name={profile.name} initials={profile.initials} color={profile.color} small />
            <span className="truncate">{profile.name}</span>
          </button>
        )}

        {/* Logout */}
        <button onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-900/20 transition-colors">
          <LogOut size={17} className="shrink-0" /> Odhlásit se
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 fixed inset-y-0 left-0 z-40">
        {sidebarContent}
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden fixed top-0 inset-x-0 z-40 h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 gap-3">
        <button onClick={() => setMobileOpen(o => !o)} className="p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <Link to="/dashboard" className="flex items-center gap-2">
          <img src={logoUrl} alt="Valbek" className="h-7 w-auto" />
          <span className="text-sm font-bold tracking-widest text-gray-800 dark:text-gray-100 uppercase">Vizualizace</span>
        </Link>
      </header>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="md:hidden fixed inset-y-0 left-0 z-50 w-56 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
            {sidebarContent}
          </aside>
        </>
      )}

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  )
}
