import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import logoUrl from '@/assets/logo.png'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/Button'

export function LoginPage() {
  const navigate  = useNavigate()
  const { login, user } = useAuthStore()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const [showReset,    setShowReset]    = useState(false)
  const [resetUser,    setResetUser]    = useState('')
  const [resetLoading, setResetLoading] = useState(false)
  const [resetError,   setResetError]   = useState('')
  const [resetOk,      setResetOk]      = useState(false)

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true })
  }, [user, navigate])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chyba přihlášení.')
    } finally {
      setLoading(false)
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setResetError('')
    setResetOk(false)
    setResetLoading(true)
    try {
      const { data: email, error: rpcErr } = await supabase
        .rpc('get_email_by_username', { p_username: resetUser.trim().toLowerCase() })
      if (!rpcErr && email) {
        await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/login`,
        })
      }
      setResetOk(true)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Chyba.')
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-8">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <img src={logoUrl} alt="Valbek" className="h-10 w-auto" />
            <div>
              <p className="text-xs font-semibold tracking-widest text-gray-400 uppercase">Valbek</p>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                Vizualizace Project Manager
              </h1>
            </div>
          </div>

          {/* Login form */}
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Uživatelské jméno
              </label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                required
                placeholder=""
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Heslo
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <Button type="submit" variant="primary" loading={loading} className="w-full justify-center">
              Přihlásit se
            </Button>
          </form>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => { setShowReset(true); setResetError(''); setResetOk(false) }}
              className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              Zapomenuté heslo
            </button>
          </div>
        </div>
      </div>

      {/* Reset modal */}
      {showReset && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={e => { if (e.target === e.currentTarget) setShowReset(false) }}
        >
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Obnovení hesla</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Zadejte vaše uživatelské jméno. Na váš email pošleme odkaz pro reset hesla.
            </p>
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <label htmlFor="reset-username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Uživatelské jméno
                </label>
                <input
                  id="reset-username"
                  type="text"
                  placeholder="tomas"
                  value={resetUser}
                  onChange={e => setResetUser(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              {resetError && <p className="text-sm text-red-600 dark:text-red-400">{resetError}</p>}
              {resetOk    && <p className="text-sm text-emerald-600 dark:text-emerald-400">Email odeslán! Zkontrolujte schránku.</p>}
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="secondary" onClick={() => setShowReset(false)}>Zrušit</Button>
                <Button type="submit" variant="primary" loading={resetLoading}>Odeslat email</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
