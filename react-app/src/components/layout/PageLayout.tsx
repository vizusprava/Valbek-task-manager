import { useLocation } from 'react-router-dom'
import { Navbar } from './Navbar'

interface PageLayoutProps {
  children: React.ReactNode
  onCreateProject?: () => void
  onCreateUser?: () => void
  onManageTemplates?: () => void
}

export function PageLayout({ children, onCreateProject, onCreateUser, onManageTemplates }: PageLayoutProps) {
  const { pathname } = useLocation()

  return (
    <div className="app-grid app-bg min-h-screen md:pl-56 pt-14 md:pt-0">
      <Navbar
        onCreateProject={onCreateProject}
        onCreateUser={onCreateUser}
        onManageTemplates={onManageTemplates}
      />
      <main key={pathname} className="page-enter max-w-screen-xl mx-auto px-6 py-6">
        {children}
      </main>
    </div>
  )
}
