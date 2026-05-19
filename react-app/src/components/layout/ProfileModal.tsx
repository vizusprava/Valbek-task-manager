import { useState, useEffect } from 'react'
import { Modal } from '@/components/ui/Modal'
import { supabase } from '@/lib/supabase'
import { AVATAR_COLORS, avatarColor } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import type { Profile } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
}

export function ProfileModal({ open, onClose }: Props) {
  const { profile, setProfile, logout } = useAuthStore()

  const [name,         setName]         = useState('')
  const [initials,     setInitials]     = useState('')
  const [color,        setColor]        = useState('')
  const [profSaving,   setProfSaving]   = useState(false)
  const [profMsg,      setProfMsg]      = useState<{ ok: boolean; text: string } | null>(null)

  const [emailNew,     setEmailNew]     = useState('')
  const [emailSaving,  setEmailSaving]  = useState(false)
  const [emailMsg,     setEmailMsg]     = useState<{ ok: boolean; text: string } | null>(null)

  const [pwNew,        setPwNew]        = useState('')
  const [pwConfirm,    setPwConfirm]    = useState('')
  const [pwSaving,     setPwSaving]     = useState(false)
  const [pwMsg,        setPwMsg]        = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!open || !profile) return
    setName(profile.name)
    setInitials((profile.initials || profile.name.slice(0, 2)).toUpperCase())
    setColor(profile.color || avatarColor(profile.name))
    setProfMsg(null); setEmailMsg(null); setPwMsg(null)
    setEmailNew(''); setPwNew(''); setPwConfirm('')
  }, [open, profile])

  const previewInitials = (initials || name.slice(0, 2)).toUpperCase() || '?'

  async function saveProfile() {
    if (!profile || !name.trim()) return
    setProfSaving(true); setProfMsg(null)
    const { error } = await supabase.from('profiles')
      .update({ name: name.trim(), initials: initials.slice(0, 2).toUpperCase() || name.slice(0, 2).toUpperCase(), color })
      .eq('id', profile.id)
    setProfSaving(false)
    if (error) { setProfMsg({ ok: false, text: error.message }); return }
    setProfile({ ...profile, name: name.trim(), initials: initials.slice(0, 2).toUpperCase(), color } as Profile)
    setProfMsg({ ok: true, text: 'Profil uložen.' })
  }

  async function changeEmail() {
    if (!emailNew.trim()) return
    setEmailSaving(true); setEmailMsg(null)
    const { error } = await supabase.auth.updateUser({ email: emailNew.trim() })
    setEmailSaving(false)
    if (error) { setEmailMsg({ ok: false, text: error.message }); return }
    setEmailMsg({ ok: true, text: 'Potvrzovací e-mail byl odeslán.' })
    setEmailNew('')
  }

  async function changePassword() {
    if (pwNew.length < 6) { setPwMsg({ ok: false, text: 'Heslo musí mít alespoň 6 znaků.' }); return }
    if (pwNew !== pwConfirm) { setPwMsg({ ok: false, text: 'Hesla se neshodují.' }); return }
    setPwSaving(true); setPwMsg(null)
    const { error } = await supabase.auth.updateUser({ password: pwNew })
    setPwSaving(false)
    if (error) { setPwMsg({ ok: false, text: error.message }); return }
    setPwMsg({ ok: true, text: 'Heslo bylo změněno.' })
    setPwNew(''); setPwConfirm('')
  }

  if (!profile) return null

  return (
    <Modal open={open} onClose={onClose} title="Můj profil" size="sm">
      <div className="space-y-0 divide-y divide-gray-100 dark:divide-gray-800">

        {/* Sekce 1: Profil */}
        <div className="pb-5 space-y-4">
          {/* Avatar náhled */}
          <div className="flex justify-center pt-1">
            <span
              className="w-14 h-14 rounded-full flex items-center justify-center font-bold text-xl text-white shrink-0"
              style={{ backgroundColor: color }}
            >
              {previewInitials}
            </span>
          </div>

          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Jméno</label>
              <input
                type="text" value={name} onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="w-24 space-y-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Iniciály</label>
              <input
                type="text" value={initials} maxLength={2}
                onChange={e => setInitials(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 uppercase"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Barva avataru</label>
            <div className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map(c => (
                <button
                  key={c} onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full transition-transform hover:scale-110 ${color === c ? 'ring-2 ring-offset-2 ring-gray-800 dark:ring-gray-200 scale-110' : ''}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>

          {profMsg && <p className={`text-xs ${profMsg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{profMsg.text}</p>}

          <button
            onClick={saveProfile} disabled={profSaving || !name.trim()}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-medium"
          >
            {profSaving ? 'Ukládám…' : 'Uložit profil'}
          </button>
        </div>

        {/* Sekce 2: E-mail */}
        <div className="py-5 space-y-3">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">E-mail pro reset hesla</p>
          <input
            type="email" value={emailNew} onChange={e => setEmailNew(e.target.value)}
            placeholder="novy@email.cz"
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {emailMsg && <p className={`text-xs ${emailMsg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{emailMsg.text}</p>}
          <button
            onClick={changeEmail} disabled={emailSaving || !emailNew.trim()}
            className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-700 dark:text-gray-300 rounded-lg font-medium"
          >
            {emailSaving ? 'Ukládám…' : 'Uložit e-mail'}
          </button>
        </div>

        {/* Sekce 3: Heslo */}
        <div className="py-5 space-y-3">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Změnit heslo</p>
          <input
            type="password" value={pwNew} onChange={e => setPwNew(e.target.value)}
            placeholder="Minimálně 6 znaků"
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <input
            type="password" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)}
            placeholder="Zopakovat heslo"
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {pwMsg && <p className={`text-xs ${pwMsg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{pwMsg.text}</p>}
          <button
            onClick={changePassword} disabled={pwSaving || !pwNew}
            className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-700 dark:text-gray-300 rounded-lg font-medium"
          >
            {pwSaving ? 'Měním…' : 'Změnit heslo'}
          </button>
        </div>

        {/* Footer: odhlásit */}
        <div className="pt-4 flex justify-between items-center">
          <button onClick={() => { onClose(); logout() }} className="text-sm text-red-500 hover:text-red-600 dark:text-red-400 font-medium">
            Odhlásit se
          </button>
          <button onClick={onClose} className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg">
            Zavřít
          </button>
        </div>
      </div>
    </Modal>
  )
}
