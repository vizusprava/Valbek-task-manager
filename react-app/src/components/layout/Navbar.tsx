import { useState, useEffect, useRef } from 'react'
import logoUrl from '@/assets/logo.png'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, ListTodo, Box, ClipboardCheck, BarChart2,
  Bell, Sun, Moon, Menu, X, LogOut, Palette, Boxes, Lightbulb, Table2,
  Map as MapIcon,
  type LucideIcon,
} from 'lucide-react'
import { useAuthStore, applyUserBg } from '@/stores/authStore'
import { LIGHT_THEMES, DARK_THEMES } from '@/lib/themes'
import { supabase } from '@/lib/supabase'
import { Avatar } from '@/components/ui/Avatar'
import { ProfileModal } from '@/components/layout/ProfileModal'
import { formatDateTime } from '@/lib/utils'
import type { Notification } from '@/lib/types'

function ThemeSwatch({ bg, accentHex, label, desc, selected, onClick }: {
  bg: string; accentHex: string; label: string; desc: string; selected: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-center gap-1.5 p-1 rounded-xl transition-all ${selected ? 'ring-2 ring-offset-2 ring-offset-white dark:ring-offset-gray-900 scale-105' : 'hover:scale-105 opacity-80 hover:opacity-100'}`}
      style={selected ? { '--tw-ring-color': accentHex } as React.CSSProperties : undefined}
    >
      {/* Mini app preview */}
      <div className="w-18 h-12 rounded-lg border border-black/10 shadow-sm overflow-hidden flex flex-col gap-0.5 p-1.5" style={{ backgroundColor: bg }}>
        <div className="w-full h-2 rounded-sm bg-black/10" />
        <div className="flex gap-1 flex-1">
          <div className="w-5 rounded-sm bg-black/8" />
          <div className="flex-1 flex flex-col gap-0.5">
            <div className="w-full h-1.5 rounded-sm" style={{ backgroundColor: accentHex + 'cc' }} />
            <div className="w-3/4 h-1.5 rounded-sm bg-black/8" />
            <div className="w-1/2 h-1.5 rounded-sm bg-black/8" />
          </div>
        </div>
      </div>
      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 leading-none">{label}</span>
      <span className="text-[10px] text-gray-400 leading-none">{desc}</span>
      {selected && (
        <div className="absolute top-1.5 right-1.5 w-3.5 h-3.5 rounded-full flex items-center justify-center" style={{ backgroundColor: accentHex }}>
          <svg viewBox="0 0 10 10" className="w-2 h-2 text-white" fill="none" stroke="currentColor" strokeWidth="1.8">
            <polyline points="1.5,5 4,7.5 8.5,2.5" />
          </svg>
        </div>
      )}
    </button>
  )
}

function UserColorSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile, setProfile } = useAuthStore()
  const [lightBg, setLightBg] = useState(profile?.bg_light ?? '#f9fafb')
  const [darkBg,  setDarkBg]  = useState(profile?.bg_dark  ?? '#030712')
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    if (open) {
      setLightBg(profile?.bg_light ?? '#f9fafb')
      setDarkBg(profile?.bg_dark   ?? '#030712')
    }
  }, [open, profile?.bg_light, profile?.bg_dark])

  function pickLight(bg: string) {
    setLightBg(bg)
    applyUserBg({ ...profile, bg_light: bg, bg_dark: darkBg } as typeof profile)
  }

  function pickDark(bg: string) {
    setDarkBg(bg)
    applyUserBg({ ...profile, bg_light: lightBg, bg_dark: bg } as typeof profile)
  }

  async function handleSave() {
    if (!profile) return
    setSaving(true)
    const updates = { bg_light: lightBg, bg_dark: darkBg }
    await supabase.from('profiles').update(updates).eq('id', profile.id)
    const updated = { ...profile, ...updates }
    setProfile(updated)
    applyUserBg(updated)
    setSaving(false)
    onClose()
  }

  function handleClose() {
    applyUserBg(profile)
    onClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={handleClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-xs p-6 space-y-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Motiv aplikace</h2>
          <button onClick={handleClose} className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Světlý režim</p>
          <div className="flex justify-between">
            {LIGHT_THEMES.map(t => (
              <ThemeSwatch key={t.bg} bg={t.bg} accentHex={t.accentHex} label={t.label} desc={t.desc}
                selected={lightBg === t.bg} onClick={() => pickLight(t.bg)} />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tmavý režim</p>
          <div className="flex justify-between">
            {DARK_THEMES.map(t => (
              <ThemeSwatch key={t.bg} bg={t.bg} accentHex={t.accentHex} label={t.label} desc={t.desc}
                selected={darkBg === t.bg} onClick={() => pickDark(t.bg)} />
            ))}
          </div>
        </div>

        <button onClick={handleSave} disabled={saving}
          className="w-full px-3 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 font-medium">
          {saving ? 'Ukládám…' : 'Uložit'}
        </button>
      </div>
    </div>
  )
}

export function Navbar() {
  const location  = useLocation()
  const navigate  = useNavigate()
  const { profile, logout, isAdmin } = useAuthStore()
  const admin = isAdmin()

  const [dark,              setDark]              = useState(() => document.documentElement.classList.contains('dark'))
  const [mobileOpen,        setMobileOpen]        = useState(false)
  const [notifOpen,         setNotifOpen]         = useState(false)
  const [profileOpen,       setProfileOpen]       = useState(false)
  const [colorSettingsOpen, setColorSettingsOpen] = useState(false)
  const [notifs,      setNotifs]      = useState<Notification[]>([])
  const [reviewCount, setReviewCount] = useState(0)
  const notifRef = useRef<HTMLDivElement>(null)

  const unreadCount = notifs.filter(n => !n.is_read).length

  function toggleDark() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
    applyUserBg(profile)
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

  const navItem = (to: string, label: string, Icon: LucideIcon, badge?: number) => (
    <Link to={to}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors relative group
        ${isActive(to)
          ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800'}`}>
      <Icon size={17} className="shrink-0" />
      {label}
      {!!badge && badge > 0 && (
        <span className="ml-auto min-w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center px-1">
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
        {navItem('/models',     '3D Modely',      Boxes)}
        {navItem('/geo',        'Geo Viewer',     MapIcon)}
        {admin && !['nela', 'lenka'].includes(profile?.name?.toLowerCase() ?? '') && navItem('/review',  'Ke kontrole', ClipboardCheck, reviewCount)}
        {navItem('/reports',    'Reporty',        BarChart2)}
        {navItem('/inspiration', 'Inspirace',     Lightbulb)}
        {navItem('/tables',     'Tabulky',        Table2)}

      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 pt-2 border-t border-gray-100 dark:border-gray-800 space-y-0.5 shrink-0">
        {/* Dark mode */}
        <button onClick={toggleDark}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
          {dark ? <Sun size={17} className="shrink-0" /> : <Moon size={17} className="shrink-0" />}
          {dark ? 'Světlý režim' : 'Tmavý režim'}
        </button>

        {/* Background color settings */}
        <button onClick={() => setColorSettingsOpen(true)}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
          <Palette size={17} className="shrink-0" />
          Barvy pozadí
        </button>

        {/* Notifications */}
        <div className="relative" ref={notifRef}>
          <button onClick={() => { setNotifOpen(o => !o); if (!notifOpen) loadNotifs() }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors">
            <Bell size={17} className="shrink-0" />
            Upozornění
            {unreadCount > 0 && (
              <span className="ml-auto min-w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center px-1">
                {unreadCount}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute bottom-full left-0 mb-1 w-80 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden z-50">
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
      <UserColorSettingsModal open={colorSettingsOpen} onClose={() => setColorSettingsOpen(false)} />
    </>
  )
}
