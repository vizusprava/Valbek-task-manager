import { create } from 'zustand'
import type { User } from '@supabase/supabase-js'
import type { Profile } from '@/lib/types'
import { supabase } from '@/lib/supabase'

export function applyUserBg(profile: Profile | null) {
  const root = document.documentElement
  if (profile?.bg_light) {
    root.style.setProperty('--user-bg-light', profile.bg_light)
  } else {
    root.style.removeProperty('--user-bg-light')
  }
  if (profile?.bg_dark) {
    root.style.setProperty('--user-bg-dark', profile.bg_dark)
  } else {
    root.style.removeProperty('--user-bg-dark')
  }
}

interface AuthState {
  user: User | null
  profile: Profile | null
  loading: boolean
  setUser: (user: User | null) => void
  setProfile: (profile: Profile | null) => void
  setLoading: (loading: boolean) => void
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  loadProfile: (userId: string) => Promise<Profile | null>
  isAdmin: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user:    null,
  profile: null,
  loading: true,

  setUser:    (user)    => set({ user }),
  setProfile: (profile) => set({ profile }),
  setLoading: (loading) => set({ loading }),

  isAdmin: () => get().profile?.role === 'admin',

  loadProfile: async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (data) {
      set({ profile: data as Profile })
      applyUserBg(data as Profile)
    }
    return data as Profile | null
  },

  login: async (username: string, password: string) => {
    const { data: email, error: rpcErr } = await supabase
      .rpc('get_email_by_username', { p_username: username.trim().toLowerCase() })

    if (rpcErr || !email) throw new Error('Uživatel nenalezen.')

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error('Špatné heslo nebo uživatelské jméno.')

    set({ user: data.user })
    await get().loadProfile(data.user.id)
  },

  logout: async () => {
    await supabase.auth.signOut()
    set({ user: null, profile: null })
  },
}))
