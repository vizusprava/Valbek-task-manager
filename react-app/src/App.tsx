import { useEffect, lazy, Suspense } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { ConfirmDialogProvider } from '@/components/ui/ConfirmDialog'

// Login + Dashboard jsou eager (úvodní paint). Zbytek lazy — hlavně 3D stránky
// (ModelsPage tahá three/drei/postprocessing) se tak nenačtou, dokud na ně uživatel nejde.
const ProjectPage   = lazy(() => import('@/pages/ProjectPage').then(m => ({ default: m.ProjectPage })))
const MyTasksPage   = lazy(() => import('@/pages/MyTasksPage').then(m => ({ default: m.MyTasksPage })))
const ReviewPage    = lazy(() => import('@/pages/ReviewPage').then(m => ({ default: m.ReviewPage })))
const ReportsPage   = lazy(() => import('@/pages/ReportsPage').then(m => ({ default: m.ReportsPage })))
const ThreeDMaxPage = lazy(() => import('@/pages/ThreeDMaxPage').then(m => ({ default: m.ThreeDMaxPage })))
const ModelsPage    = lazy(() => import('@/pages/ModelsPage').then(m => ({ default: m.ModelsPage })))
const InspiracePage = lazy(() => import('@/pages/InspiracePage').then(m => ({ default: m.InspiracePage })))
const TablesPage    = lazy(() => import('@/pages/TablesPage').then(m => ({ default: m.TablesPage })))
const GeoPage       = lazy(() => import('@/pages/GeoPage').then(m => ({ default: m.GeoPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

function PageSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const isAdmin = useAuthStore(s => s.isAdmin())
  if (!isAdmin) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export default function App() {
  const { setUser, setLoading, loadProfile } = useAuthStore()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        loadProfile(session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) loadProfile(session.user.id)
    })

    return () => subscription.unsubscribe()
  }, [setUser, setLoading, loadProfile])

  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmDialogProvider>
      <HashRouter>
        <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<AuthGuard><DashboardPage /></AuthGuard>} />
          <Route path="/dashboard" element={<AuthGuard><DashboardPage /></AuthGuard>} />
          <Route path="/project/:id" element={<AuthGuard><ProjectPage /></AuthGuard>} />
          <Route path="/my-tasks" element={<AuthGuard><MyTasksPage /></AuthGuard>} />
          <Route path="/3dmax" element={<AuthGuard><ThreeDMaxPage /></AuthGuard>} />
          <Route path="/models" element={<AuthGuard><ModelsPage /></AuthGuard>} />
          <Route path="/geo" element={<AuthGuard><GeoPage /></AuthGuard>} />
          <Route path="/review" element={<AuthGuard><AdminGuard><ReviewPage /></AdminGuard></AuthGuard>} />
          <Route path="/reports" element={<AuthGuard><ReportsPage /></AuthGuard>} />
          <Route path="/inspiration" element={<AuthGuard><InspiracePage /></AuthGuard>} />
          <Route path="/tables" element={<AuthGuard><TablesPage /></AuthGuard>} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </Suspense>
      </HashRouter>
      <Toaster position="bottom-right" richColors />
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
}
