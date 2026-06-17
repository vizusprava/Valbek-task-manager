import { lazy, Suspense } from 'react'
import { useLocation } from 'react-router-dom'
import { Navbar } from './Navbar'

// dekorativní 3D pozadí tahá three.js — načti ho lazy, ať není v hlavním balíku
const BackgroundScene = lazy(() => import('./BackgroundScene').then(m => ({ default: m.BackgroundScene })))

interface PageLayoutProps {
  children: React.ReactNode
}

export function PageLayout({ children }: PageLayoutProps) {
  const { pathname } = useLocation()

  return (
    <div className="app-grid app-bg min-h-screen md:pl-56 pt-14 md:pt-0 relative">
      <Suspense fallback={null}><BackgroundScene /></Suspense>
      <Navbar />
      <main key={pathname} className="page-enter max-w-7xl mx-auto px-6 py-6 relative" style={{ zIndex: 1 }}>
        {children}
      </main>
    </div>
  )
}
