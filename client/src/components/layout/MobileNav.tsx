import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Brain, BarChart3, GraduationCap, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/modules', icon: GraduationCap, label: 'Modules' },
  { to: '/quiz', icon: Brain, label: 'Quiz' },
  { to: '/progress', icon: BarChart3, label: 'Progress' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export function MobileNav({ isAdmin: _isAdmin }: { isAdmin?: boolean }) {
  // Mobile nav is always the same — admin features (schedule, ingest)
  // are accessible from desktop sidebar only or via direct URL.
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
      <div className="flex items-center justify-around h-16">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )
            }
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
