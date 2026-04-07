import { Outlet, NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  Brain,
  MessageSquare,
  Calendar,
  BarChart3,
  Settings,
  GraduationCap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MobileNav } from './MobileNav'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '@/lib/auth'

const allNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', adminOnly: false },
  { to: '/modules', icon: GraduationCap, label: 'Modules', adminOnly: false },
  { to: '/quiz', icon: Brain, label: 'Quiz', adminOnly: false },
  { to: '/progress', icon: BarChart3, label: 'Progress', adminOnly: false },
  { to: '/chat', icon: MessageSquare, label: 'Learn', adminOnly: false },
  { to: '/ingest', icon: Upload, label: 'Ingest Notes', adminOnly: true },
  { to: '/schedule', icon: Calendar, label: 'Schedule', adminOnly: true },
  { to: '/settings', icon: Settings, label: 'Settings', adminOnly: false },
]

export function AppShell() {
  const { isAdmin } = useAuth()
  const navItems = allNavItems.filter((item) => !item.adminOnly || isAdmin)

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:flex md:w-56 md:flex-col border-r border-border bg-sidebar">
        <div className="flex h-16 items-center justify-between px-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2 pl-2">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold text-xs">
              ck
            </div>
            <h1 className="text-lg font-semibold text-sidebar-foreground">
              Cramkit
            </h1>
          </div>
          <ThemeToggle />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="md:pl-56 pb-20 md:pb-0">
        <div className="mx-auto max-w-5xl p-4 md:p-8">
          <Outlet />
        </div>
      </main>

      <MobileNav isAdmin={isAdmin} />
    </div>
  )
}
