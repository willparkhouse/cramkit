import { useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/useAppStore'
import { MODULE_COLOURS, MODULE_SHORT_NAMES } from '@/lib/constants'
import * as api from '@/lib/api'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { RevisionSlot } from '@/types'

const HOURS = Array.from({ length: 15 }, (_, i) => i + 8) // 8am to 10pm
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function getWeekStart(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function formatWeekLabel(weekStart: Date): string {
  const end = addDays(weekStart, 6)
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  return `${weekStart.toLocaleDateString('en-GB', opts)} – ${end.toLocaleDateString('en-GB', opts)}`
}

function slotHours(slot: RevisionSlot): number {
  return (new Date(slot.end_time).getTime() - new Date(slot.start_time).getTime()) / (1000 * 60 * 60)
}

export function SchedulePage() {
  const exams = useAppStore((s) => s.exams)
  const slots = useAppStore((s) => s.revisionSlots)
  const setSlots = useAppStore((s) => s.setRevisionSlots)

  const [weekOffset, setWeekOffset] = useState(0)
  const [allocating, setAllocating] = useState(false)

  const weekStart = useMemo(() => {
    const base = getWeekStart(new Date())
    return addDays(base, weekOffset * 7)
  }, [weekOffset])

  const weekEnd = addDays(weekStart, 7)

  // Slots for the current week view
  const weekSlots = useMemo(() => {
    return slots
      .filter((s) => {
        const start = new Date(s.start_time)
        return start >= weekStart && start < weekEnd
      })
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
  }, [slots, weekStart, weekEnd])

  // Module stats — break down by completed/pending/skipped
  const moduleStats = useMemo(() => {
    const stats = new Map<string, {
      name: string; shortName: string; colour: string
      totalHours: number; totalSessions: number
      completedHours: number; completedSessions: number
      skippedHours: number; skippedSessions: number
      pendingHours: number; pendingSessions: number
    }>()

    for (const exam of exams) {
      stats.set(exam.id, {
        name: exam.name,
        shortName: MODULE_SHORT_NAMES[exam.name] || exam.name,
        colour: MODULE_COLOURS[exam.name] || '#888',
        totalHours: 0, totalSessions: 0,
        completedHours: 0, completedSessions: 0,
        skippedHours: 0, skippedSessions: 0,
        pendingHours: 0, pendingSessions: 0,
      })
    }

    let unallocatedHours = 0
    let unallocatedSessions = 0

    for (const slot of slots) {
      const hours = slotHours(slot)
      if (slot.allocated_module_id && stats.has(slot.allocated_module_id)) {
        const s = stats.get(slot.allocated_module_id)!
        s.totalHours += hours
        s.totalSessions += 1
        const status = slot.status || 'pending'
        if (status === 'completed') { s.completedHours += hours; s.completedSessions += 1 }
        else if (status === 'skipped') { s.skippedHours += hours; s.skippedSessions += 1 }
        else { s.pendingHours += hours; s.pendingSessions += 1 }
      } else {
        unallocatedHours += hours
        unallocatedSessions += 1
      }
    }

    return { stats, unallocatedHours, unallocatedSessions }
  }, [slots, exams])

  const getModuleColour = (id: string | null) => {
    if (!id) return '#d4d4d8'
    const exam = exams.find((e) => e.id === id)
    return exam ? MODULE_COLOURS[exam.name] || '#888' : '#888'
  }

  const getModuleShortName = (id: string | null) => {
    if (!id) return ''
    const exam = exams.find((e) => e.id === id)
    return exam ? MODULE_SHORT_NAMES[exam.name] || exam.name : ''
  }

  const updateSlotStatus = async (slotId: string, status: 'completed' | 'skipped' | 'pending') => {
    await api.updateSlot(slotId, { status })
    setSlots(slots.map((s) => s.id === slotId ? { ...s, status } : s))
  }

  const reallocateSlots = async () => {
    setAllocating(true)

    // Sort slots by date
    const sorted = [...slots].sort(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    )

    // Completed slots keep their allocation. Only pending/skipped get reassigned.
    // Skipped hours from a module mean that module needs MORE future hours to compensate.

    // Backwards allocation:
    // Work from the last slot to the first. This guarantees SRWS (last exam)
    // gets its fair share first, then each earlier exam claims from what's left.
    //
    // Step 1: Compute target hours per module (weight-proportional)
    // Step 2: Walk backwards through slots. For each slot, assign to the
    //         active exam (not yet passed) that is furthest below its target.
    //         Semester bias used as tiebreaker: sem1 (NC) preferred earlier,
    //         sem2 (NLP) preferred later.
    // Step 3: Reverse the assignments back to chronological order.

    const totalHours = sorted.reduce((sum, s) => sum + slotHours(s), 0)
    const totalWeight = exams.reduce((sum, e) => sum + e.weight, 0)

    const targetHours = new Map<string, number>()
    for (const exam of exams) {
      targetHours.set(exam.id, totalHours * (exam.weight / totalWeight))
    }

    // Pre-count completed hours (these are locked in)
    const completedHoursPerModule = new Map<string, number>()
    for (const exam of exams) completedHoursPerModule.set(exam.id, 0)
    for (const slot of sorted) {
      if (slot.status === 'completed' && slot.allocated_module_id) {
        const cur = completedHoursPerModule.get(slot.allocated_module_id) || 0
        completedHoursPerModule.set(slot.allocated_module_id, cur + slotHours(slot))
      }
    }

    // Walk backwards, only reassigning pending slots
    const reversed = [...sorted].reverse()
    const hoursPerModule = new Map<string, number>()
    // Start with completed hours already counted
    for (const exam of exams) hoursPerModule.set(exam.id, completedHoursPerModule.get(exam.id) || 0)

    const assignments = new Map<string, string>() // slot.id -> exam.id

    // Track how many pending slots we process for reverseProgress
    const pendingSlots = reversed.filter((s) => s.status !== 'completed')
    let pendingIndex = 0

    for (const slot of reversed) {
      const hours = slotHours(slot)

      // Completed slots keep their allocation
      if (slot.status === 'completed') {
        if (slot.allocated_module_id) {
          assignments.set(slot.id, slot.allocated_module_id)
        }
        continue
      }

      const slotDate = new Date(slot.start_time)
      const reverseProgress = pendingIndex / Math.max(pendingSlots.length, 1)
      pendingIndex++

      // Active exams: those whose exam date is AFTER this slot
      const activeExams = exams.filter((e) => new Date(e.date) > slotDate)
      if (activeExams.length === 0) {
        assignments.set(slot.id, exams[exams.length - 1]?.id || '')
        continue
      }

      let bestId = activeExams[0].id
      let bestScore = -Infinity

      for (const exam of activeExams) {
        const target = targetHours.get(exam.id) || 0
        const current = hoursPerModule.get(exam.id) || 0

        if (current >= target) {
          if (-10 > bestScore) { bestScore = -10; bestId = exam.id }
          continue
        }

        const deficit = (target - current) / Math.max(target, 1)

        const daysUntil = Math.max(1, (new Date(exam.date).getTime() - slotDate.getTime()) / (1000 * 60 * 60 * 24))
        const proximity = 1 / Math.sqrt(daysUntil)

        let semBias = 0
        if (exam.semester === 1) {
          semBias = reverseProgress > 0.5 ? 0.06 : -0.02
        } else {
          semBias = reverseProgress < 0.6 ? 0.03 : -0.01
        }

        const score = deficit + proximity * 0.08 + semBias

        if (score > bestScore) {
          bestScore = score
          bestId = exam.id
        }
      }

      hoursPerModule.set(bestId, (hoursPerModule.get(bestId) || 0) + hours)
      assignments.set(slot.id, bestId)
    }

    const updated = sorted.map((slot) => ({
      ...slot,
      allocated_module_id: assignments.get(slot.id) || null,
    }))

    // Save
    for (const slot of updated) {
      await api.updateSlot(slot.id, { allocated_module_id: slot.allocated_module_id })
    }
    setSlots(updated)
    setAllocating(false)
  }

  // Past slots that need marking
  const pastUnmarked = useMemo(() => {
    const now = new Date()
    return slots
      .filter((s) => new Date(s.end_time) < now && (s.status === 'pending' || !s.status))
      .sort((a, b) => new Date(b.end_time).getTime() - new Date(a.end_time).getTime())
  }, [slots])

  // Render a slot on the calendar grid
  function renderSlot(slot: RevisionSlot) {
    const start = new Date(slot.start_time)
    const end = new Date(slot.end_time)
    const startHour = start.getHours() + start.getMinutes() / 60
    const endHour = end.getHours() + end.getMinutes() / 60
    const top = ((startHour - 8) / 15) * 100
    const height = ((endHour - startHour) / 15) * 100
    const colour = getModuleColour(slot.allocated_module_id)
    const label = getModuleShortName(slot.allocated_module_id)
    const duration = Math.round((endHour - startHour) * 10) / 10
    const status = slot.status || 'pending'

    const opacity = status === 'skipped' ? 0.35 : status === 'completed' ? 1 : 0.8
    const strikethrough = status === 'skipped'

    return (
      <div
        key={slot.id}
        className="absolute left-0.5 right-0.5 rounded-md px-1.5 py-0.5 text-white text-[10px] font-medium overflow-hidden cursor-default border border-white/20"
        style={{
          top: `${top}%`,
          height: `${height}%`,
          backgroundColor: colour,
          minHeight: '18px',
          opacity,
        }}
        title={`${label} — ${duration}h — ${status}`}
      >
        <div className={`truncate ${strikethrough ? 'line-through' : ''}`}>
          {status === 'completed' ? '✓ ' : ''}{label}
        </div>
        {height > 8 && <div className="opacity-70">{duration}h</div>}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Schedule</h1>
        <Button
          variant="outline"
          onClick={reallocateSlots}
          disabled={slots.length === 0 || allocating}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${allocating ? 'animate-spin' : ''}`} />
          {allocating ? 'Allocating...' : 'Re-allocate'}
        </Button>
      </div>

      {/* Module stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from(moduleStats.stats.values()).map((stat) => (
          <Card key={stat.name}>
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-2 mb-1">
                <div
                  className="w-3 h-3 rounded-sm shrink-0"
                  style={{ backgroundColor: stat.colour }}
                />
                <span className="text-sm font-medium">{stat.shortName}</span>
              </div>
              <div className="text-2xl font-bold">{Math.round(stat.totalHours)}h</div>
              <div className="text-xs text-muted-foreground space-x-2">
                <span>{stat.totalSessions} sessions</span>
                {stat.completedSessions > 0 && (
                  <span className="text-green-600">{stat.completedSessions} done</span>
                )}
                {stat.skippedSessions > 0 && (
                  <span className="text-red-400">{stat.skippedSessions} skipped</span>
                )}
              </div>
              {stat.completedSessions > 0 && (
                <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded-full"
                    style={{ width: `${(stat.completedHours / stat.totalHours) * 100}%` }}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {moduleStats.unallocatedSessions > 0 && (
        <div className="text-sm text-muted-foreground">
          {moduleStats.unallocatedSessions} unallocated sessions ({Math.round(moduleStats.unallocatedHours)}h) — click Re-allocate
        </div>
      )}

      {/* Past sessions to mark */}
      {pastUnmarked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Mark past sessions ({pastUnmarked.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pastUnmarked.slice(0, 5).map((slot) => {
              const moduleName = getModuleShortName(slot.allocated_module_id)
              const colour = getModuleColour(slot.allocated_module_id)
              const hours = Math.round(slotHours(slot) * 10) / 10
              const date = new Date(slot.start_time)
              const dateStr = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
              const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

              return (
                <div key={slot.id} className="flex items-center gap-3 py-1">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colour }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{moduleName}</span>
                    <span className="text-xs text-muted-foreground ml-2">{dateStr} {timeStr} ({hours}h)</span>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs text-green-600 border-green-200 hover:bg-green-50"
                      onClick={() => updateSlotStatus(slot.id, 'completed')}
                    >
                      Did it
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs text-red-400 border-red-200 hover:bg-red-50"
                      onClick={() => updateSlotStatus(slot.id, 'skipped')}
                    >
                      Didn't
                    </Button>
                  </div>
                </div>
              )
            })}
            {pastUnmarked.length > 5 && (
              <p className="text-xs text-muted-foreground">
                +{pastUnmarked.length - 5} more past sessions
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Week navigation */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setWeekOffset((w) => w - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">{formatWeekLabel(weekStart)}</span>
        <Button variant="ghost" size="sm" onClick={() => setWeekOffset((w) => w + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Calendar grid */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <div className="min-w-[700px]">
            {/* Day headers */}
            <div className="grid grid-cols-[50px_repeat(7,1fr)] border-b">
              <div />
              {DAYS.map((day, i) => {
                const date = addDays(weekStart, i)
                const isToday = date.toDateString() === new Date().toDateString()
                return (
                  <div
                    key={day}
                    className={`text-center py-2 text-xs font-medium border-l ${
                      isToday ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
                    }`}
                  >
                    <div>{day}</div>
                    <div className={`text-lg ${isToday ? 'font-bold' : ''}`}>
                      {date.getDate()}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Time grid */}
            <div className="grid grid-cols-[50px_repeat(7,1fr)] relative">
              {/* Hour labels */}
              <div>
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="h-12 flex items-start justify-end pr-2 text-[10px] text-muted-foreground -mt-1.5"
                  >
                    {hour.toString().padStart(2, '0')}:00
                  </div>
                ))}
              </div>

              {/* Day columns */}
              {DAYS.map((_, dayIndex) => {
                const dayDate = addDays(weekStart, dayIndex)
                const daySlots = weekSlots.filter((s) => {
                  const d = new Date(s.start_time)
                  return d.getDate() === dayDate.getDate() &&
                    d.getMonth() === dayDate.getMonth() &&
                    d.getFullYear() === dayDate.getFullYear()
                })

                return (
                  <div key={dayIndex} className="relative border-l">
                    {/* Hour grid lines */}
                    {HOURS.map((hour) => (
                      <div key={hour} className="h-12 border-b border-border/50" />
                    ))}

                    {/* Slots */}
                    {daySlots.map((slot) => renderSlot(slot))}
                  </div>
                )
              })}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
