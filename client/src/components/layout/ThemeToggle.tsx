import { Sun, Moon, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/lib/theme'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()

  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  const label =
    theme === 'light' ? 'Light mode' : theme === 'dark' ? 'Dark mode' : 'System theme'

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      <Icon className="h-4 w-4" />
    </Button>
  )
}
