import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function daysUntil(date: string): number {
  const now = new Date()
  const target = new Date(date)
  const diff = target.getTime() - now.getTime()
  return Math.max(0, diff / (1000 * 60 * 60 * 24))
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function daysSince(date: string | null): number {
  if (!date) return Infinity
  const then = new Date(date)
  const now = new Date()
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24)
}
