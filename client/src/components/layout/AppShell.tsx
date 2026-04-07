import { Outlet, NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  Brain,
  Search,
  Calendar,
  BarChart3,
  Settings,
  GraduationCap,
} from 'lucide-react'

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18a10.95 10.95 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.63 1.58.23 2.75.12 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}
import { cn } from '@/lib/utils'
import { MobileNav } from './MobileNav'
import { ThemeToggle } from './ThemeToggle'
import { Logo } from './Logo'
import { useAuth } from '@/lib/auth'

const allNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', adminOnly: false },
  { to: '/quiz', icon: Brain, label: 'Quiz', adminOnly: false },
  { to: '/search', icon: Search, label: 'Search materials', adminOnly: false },
  { to: '/progress', icon: BarChart3, label: 'Progress', adminOnly: false },
  { to: '/modules', icon: GraduationCap, label: 'Modules', adminOnly: false },
  { to: '/admin', icon: Upload, label: 'Admin', adminOnly: true },
  { to: '/schedule', icon: Calendar, label: 'Schedule', adminOnly: true },
  { to: '/settings', icon: Settings, label: 'Settings', adminOnly: false },
]

export function AppShell() {
  const { isAdmin } = useAuth()
  const navItems = allNavItems.filter((item) => !item.adminOnly || isAdmin)

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:flex md:w-60 md:flex-col border-r border-border bg-sidebar">
        <NavLink to="/" className="block px-5 pt-3 pb-3 hover:opacity-80 transition-opacity">
          <Logo className="w-full" />
        </NavLink>
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
        <div className="p-3 border-t border-sidebar-border space-y-2">
          <div className="flex items-center justify-between">
            <a
              href="https://github.com/willparkhouse/cramkit"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2"
              title="View source on GitHub"
            >
              <GithubIcon className="h-3.5 w-3.5" />
              GitHub
            </a>
            <ThemeToggle />
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground px-2">
            <NavLink to="/terms" className="hover:text-foreground transition-colors">Terms</NavLink>
            <span>·</span>
            <NavLink to="/privacy" className="hover:text-foreground transition-colors">Privacy</NavLink>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="md:pl-60 pb-20 md:pb-0">
        <div className="mx-auto max-w-5xl p-4 md:p-8">
          <Outlet />
        </div>
      </main>

      <MobileNav isAdmin={isAdmin} />
    </div>
  )
}
