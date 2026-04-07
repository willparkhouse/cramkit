import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

interface LogoProps {
  className?: string
  /** Visual height in px (width auto from aspect ratio). Ignored if className sets width. */
  height?: number
}

/**
 * Theme-aware brand mark. Renders the dark-mode logo when the active theme
 * resolves to dark, otherwise the light-mode logo.
 */
export function Logo({ className, height }: LogoProps) {
  const { resolved } = useTheme()
  const src = resolved === 'dark' ? '/logos/cramkit-dark.png' : '/logos/cramkit-light.png'

  return (
    <img
      src={src}
      alt="cramkit"
      style={height ? { height } : undefined}
      className={cn('h-auto w-auto select-none', className)}
      draggable={false}
    />
  )
}
