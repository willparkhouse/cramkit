import { useState, useEffect, useCallback } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { IngestionPage } from '@/components/ingestion/IngestionPage'
import {
  adminListModules,
  adminCreateModule,
  adminListSources,
  adminDeleteSource,
  adminUploadSlides,
  adminUploadTranscript,
  type AdminModule,
  type AdminSource,
} from '@/lib/api'
import { Loader2, Plus, Trash2, FileText, Mic, BookOpen, AlertCircle } from 'lucide-react'

type TabKey = 'modules' | 'slides' | 'transcripts' | 'notes'

export function AdminPage() {
  const [tab, setTab] = useState<TabKey>('modules')
  const [modules, setModules] = useState<AdminModule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Module selection is shared across the slides/transcripts/notes tabs so the
  // user doesn't accidentally ingest into the default exam after switching tabs.
  const [moduleSlug, setModuleSlug] = useState<string>('')

  useEffect(() => {
    if (!moduleSlug && modules && modules.length > 0) setModuleSlug(modules[0].slug)
  }, [modules, moduleSlug])

  const reload = useCallback(async () => {
    setError(null)
    try {
      setModules(await adminListModules())
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-3xl font-display font-semibold">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage modules and ingest source material. Question generation is grounded in
          slide + lecture chunks, so a module is only ready for quizzes once you've ingested
          its sources here.
        </p>
      </div>

      {error && (
        <Card className="mb-4 border-destructive">
          <CardContent className="pt-4 text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="mb-4">
          <TabsTrigger value="modules"><BookOpen className="h-4 w-4 mr-1.5" />Modules</TabsTrigger>
          <TabsTrigger value="slides"><FileText className="h-4 w-4 mr-1.5" />Slides</TabsTrigger>
          <TabsTrigger value="transcripts"><Mic className="h-4 w-4 mr-1.5" />Transcripts</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="modules">
          <ModulesTab modules={modules} onChange={reload} />
        </TabsContent>

        <TabsContent value="slides">
          <SlidesTab modules={modules ?? []} moduleSlug={moduleSlug} setModuleSlug={setModuleSlug} onChange={reload} />
        </TabsContent>

        <TabsContent value="transcripts">
          <TranscriptsTab modules={modules ?? []} moduleSlug={moduleSlug} setModuleSlug={setModuleSlug} onChange={reload} />
        </TabsContent>

        <TabsContent value="notes">
          <NotesTab modules={modules ?? []} moduleSlug={moduleSlug} setModuleSlug={setModuleSlug} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Notes tab — wraps the existing IngestionPage with a shared module picker so
// dropped files default to the currently-selected admin module instead of
// silently going to whatever exam happens to be alphabetically first.
// ----------------------------------------------------------------------------

function NotesTab({
  modules,
  moduleSlug,
  setModuleSlug,
}: {
  modules: AdminModule[]
  moduleSlug: string
  setModuleSlug: (s: string) => void
}) {
  const selectedModule = modules.find((m) => m.slug === moduleSlug)
  return (
    <div className="space-y-4">
      <ModulePicker modules={modules} value={moduleSlug} onChange={setModuleSlug} />
      <p className="text-xs text-muted-foreground">
        New files dropped below will default to <strong>{selectedModule?.name ?? '—'}</strong>.
        You can still change the per-file module on each row before starting extraction.
      </p>
      <IngestionPage defaultModuleId={selectedModule?.id} />
    </div>
  )
}

// ----------------------------------------------------------------------------
// Modules tab — list + create
// ----------------------------------------------------------------------------

function ModulesTab({ modules, onChange }: { modules: AdminModule[] | null; onChange: () => void }) {
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', slug: '', date: '', weight: 0.25, semester: 2 })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    setBusy(true)
    try {
      await adminCreateModule({
        name: form.name,
        slug: form.slug,
        date: new Date(form.date).toISOString(),
        weight: form.weight,
        semester: form.semester,
      })
      setCreating(false)
      setForm({ name: '', slug: '', date: '', weight: 0.25, semester: 2 })
      onChange()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (modules === null) {
    return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
  }

  return (
    <div className="space-y-3">
      {modules.map((m) => (
        <Card key={m.id}>
          <CardContent className="pt-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium">{m.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  slug: <code className="bg-muted px-1 py-0.5 rounded">{m.slug}</code> · exam{' '}
                  {new Date(m.date).toLocaleDateString()}
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>{m.coverage.slide_decks} slide decks</div>
                <div>{m.coverage.lectures} lectures</div>
                <div>{m.coverage.chunks.toLocaleString()} chunks</div>
              </div>
            </div>
            {m.coverage.chunks === 0 && (
              <div className="mt-2 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="h-3 w-3" />
                No source chunks yet — question generation will return 0 questions for this module.
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {creating ? (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Display name">
                <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Evolutionary Computation" />
              </Field>
              <Field label="Slug">
                <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="evocomp" />
              </Field>
              <Field label="Exam date">
                <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </Field>
              <Field label="Weight (0–1)">
                <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" type="number" step="0.05" min="0" max="1" value={form.weight} onChange={(e) => setForm({ ...form, weight: parseFloat(e.target.value) })} />
              </Field>
              <Field label="Semester">
                <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" type="number" min="1" max="2" value={form.semester} onChange={(e) => setForm({ ...form, semester: parseInt(e.target.value) })} />
              </Field>
            </div>
            {err && <div className="text-sm text-destructive">{err}</div>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
              <Button size="sm" onClick={submit} disabled={busy || !form.name || !form.slug || !form.date}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4 mr-1.5" /> New module
        </Button>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Slides tab — pick a module, drop PDFs, watch progress
// ----------------------------------------------------------------------------

interface SlideQueueRow {
  file: File
  week: number | null
  lecture: string
  title: string
  status: 'pending' | 'running' | 'done' | 'error'
  message?: string
}

/** Best-effort guess at lecture/title from a filename like "13.1. EMV Lecture.pdf" or "1+2. BinaryReview.pdf". */
function guessSlideMetadata(filename: string): { lecture: string; title: string } {
  const stem = filename.replace(/\.pdf$/i, '')
  // Match leading number / number-with-suffix / multi-lecture (e.g. "1+2", "13.1", "10")
  const m = stem.match(/^([\d.+]+)[.\s]+(.+)$/)
  if (m) return { lecture: m[1], title: m[2].trim() }
  return { lecture: '', title: stem }
}

function SlidesTab({
  modules,
  moduleSlug,
  setModuleSlug,
  onChange,
}: {
  modules: AdminModule[]
  moduleSlug: string
  setModuleSlug: (s: string) => void
  onChange: () => void
}) {
  const [sources, setSources] = useState<AdminSource[]>([])
  const [queue, setQueue] = useState<SlideQueueRow[]>([])
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const reloadSources = useCallback(async () => {
    if (!moduleSlug) return
    try {
      const all = await adminListSources(moduleSlug)
      setSources(all.filter((s) => s.source_type === 'slides'))
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [moduleSlug])

  useEffect(() => { void reloadSources() }, [reloadSources])

  const addFiles = (fl: FileList) => {
    const newRows: SlideQueueRow[] = Array.from(fl)
      .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
      .map((f) => {
        const { lecture, title } = guessSlideMetadata(f.name)
        return { file: f, week: null, lecture, title, status: 'pending' as const }
      })
    setQueue((q) => [...q, ...newRows])
  }

  const updateRow = (i: number, patch: Partial<SlideQueueRow>) => {
    setQueue((q) => q.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const removeRow = (i: number) => {
    setQueue((q) => q.filter((_, idx) => idx !== i))
  }

  const ingestRow = async (i: number): Promise<boolean> => {
    const row = queue[i]
    if (!moduleSlug || row.week === null) return false
    updateRow(i, { status: 'running' })
    try {
      const res = await adminUploadSlides({
        moduleSlug,
        week: row.week,
        lecture: row.lecture || undefined,
        title: row.title || undefined,
        file: row.file,
      })
      updateRow(i, { status: 'done', message: `${res.pages} pages → ${res.chunks_inserted} chunks` })
      return true
    } catch (e) {
      updateRow(i, { status: 'error', message: (e as Error).message })
      return false
    }
  }

  const ingestAll = async () => {
    setRunning(true)
    setErr(null)
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status === 'done') continue
      if (queue[i].week === null) continue
      await ingestRow(i)
    }
    setRunning(false)
    await reloadSources()
    onChange()
  }

  const deleteSource = async (id: string) => {
    if (!confirm('Delete this slide deck and all its chunks?')) return
    try {
      await adminDeleteSource(id)
      await reloadSources()
      onChange()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const readyCount = queue.filter((r) => r.week !== null && r.status !== 'done').length

  return (
    <div className="space-y-4">
      <ModulePicker modules={modules} value={moduleSlug} onChange={setModuleSlug} />

      <Card>
        <CardContent className="pt-4 space-y-3">
          <label className="block">
            <div className="border-2 border-dashed border-border rounded-lg p-6 text-center hover:border-primary transition-colors cursor-pointer">
              <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <div className="text-sm">Drop slide PDFs to add to the queue</div>
              <div className="text-xs text-muted-foreground mt-1">
                Each deck is tagged manually — slides belong to lectures, not weeks. Lecture id can be
                anything (<code>1</code>, <code>13.1</code>, <code>1+2</code>).
              </div>
            </div>
            <input
              type="file"
              accept="application/pdf"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />
          </label>

          {queue.length > 0 && (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted">
                  <tr className="text-left">
                    <th className="px-2 py-1.5">Filename</th>
                    <th className="px-2 py-1.5 w-16">Week</th>
                    <th className="px-2 py-1.5 w-24">Lecture</th>
                    <th className="px-2 py-1.5">Title</th>
                    <th className="px-2 py-1.5 w-32">Status</th>
                    <th className="px-2 py-1.5 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((row, i) => (
                    <tr key={i} className="border-t align-middle">
                      <td className="px-2 py-1 font-mono truncate max-w-[200px]" title={row.file.name}>
                        {row.file.name}
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="1"
                          className="w-14 border rounded px-1.5 py-0.5 bg-background"
                          value={row.week ?? ''}
                          onChange={(e) => updateRow(i, { week: e.target.value ? parseInt(e.target.value) : null })}
                          disabled={row.status === 'running' || row.status === 'done'}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          className="w-20 border rounded px-1.5 py-0.5 bg-background"
                          value={row.lecture}
                          onChange={(e) => updateRow(i, { lecture: e.target.value })}
                          disabled={row.status === 'running' || row.status === 'done'}
                          placeholder="e.g. 13.1"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          className="w-full border rounded px-1.5 py-0.5 bg-background"
                          value={row.title}
                          onChange={(e) => updateRow(i, { title: e.target.value })}
                          disabled={row.status === 'running' || row.status === 'done'}
                        />
                      </td>
                      <td className="px-2 py-1">
                        {row.status === 'pending' && (row.week === null
                          ? <span className="text-amber-600 dark:text-amber-400">needs week</span>
                          : <span className="text-muted-foreground">ready</span>)}
                        {row.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
                        {row.status === 'done' && <span className="text-emerald-600 dark:text-emerald-400">{row.message}</span>}
                        {row.status === 'error' && <span className="text-destructive" title={row.message}>{row.message}</span>}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {row.status !== 'done' && row.status !== 'running' && (
                          <div className="flex gap-1 justify-end">
                            <Button size="sm" variant="ghost" className="h-6 px-2" disabled={row.week === null} onClick={() => ingestRow(i)}>
                              ↑
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => removeRow(i)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {err && <div className="text-sm text-destructive">{err}</div>}

          {queue.length > 0 && (
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                {readyCount} ready to ingest
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setQueue((q) => q.filter((r) => r.status !== 'done'))}>
                  Clear done
                </Button>
                <Button onClick={ingestAll} disabled={running || readyCount === 0 || !moduleSlug}>
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : `Ingest ${readyCount} decks`}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ExistingSourcesList
        title="Existing slide decks"
        sources={sources}
        selected={selected}
        setSelected={setSelected}
        onDelete={async (ids) => {
          for (const id of ids) {
            try { await adminDeleteSource(id) } catch (e) { setErr((e as Error).message) }
          }
          await reloadSources()
          onChange()
        }}
        renderRow={(s) => (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">{s.title || s.code}</div>
              <div className="text-xs text-muted-foreground">
                week {s.week ?? '—'} {s.lecture && <Badge variant="secondary" className="ml-1">lecture {s.lecture}</Badge>} · <code>{s.code}</code>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => deleteSource(s.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      />
    </div>
  )
}

// ----------------------------------------------------------------------------
// Transcripts tab — paste-based form
// ----------------------------------------------------------------------------

function TranscriptsTab({
  modules,
  moduleSlug,
  setModuleSlug,
  onChange,
}: {
  modules: AdminModule[]
  moduleSlug: string
  setModuleSlug: (s: string) => void
  onChange: () => void
}) {
  const [sources, setSources] = useState<AdminSource[]>([])
  const [form, setForm] = useState({ week: 1, lecture: '1', panopto_url: '', transcript_text: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [last, setLast] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const reloadSources = useCallback(async () => {
    if (!moduleSlug) return
    try {
      const all = await adminListSources(moduleSlug)
      setSources(all.filter((s) => s.source_type === 'lecture'))
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [moduleSlug])

  useEffect(() => { void reloadSources() }, [reloadSources])

  const submit = async () => {
    setErr(null)
    setBusy(true)
    setLast(null)
    try {
      const res = await adminUploadTranscript({
        module: moduleSlug,
        week: form.week,
        lecture: form.lecture,
        panopto_url: form.panopto_url,
        transcript_text: form.transcript_text,
      })
      setLast(`${res.code}: ${res.lines} lines → ${res.chunks_inserted} chunks`)
      setForm({ ...form, transcript_text: '', panopto_url: '' })
      await reloadSources()
      onChange()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const deleteSource = async (id: string) => {
    if (!confirm('Delete this transcript and all its chunks?')) return
    try {
      await adminDeleteSource(id)
      await reloadSources()
      onChange()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      <ModulePicker modules={modules} value={moduleSlug} onChange={setModuleSlug} />

      <BulkTranscriptImporter
        moduleSlug={moduleSlug}
        onComplete={async () => { await reloadSources(); onChange() }}
      />

      <details className="space-y-3">
        <summary className="text-sm font-medium text-muted-foreground cursor-pointer select-none">
          Single transcript (paste)
        </summary>
      <Card className="mt-3">
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Week">
              <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" type="number" min="1" value={form.week} onChange={(e) => setForm({ ...form, week: parseInt(e.target.value) || 1 })} />
            </Field>
            <Field label="Lecture id">
              <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" value={form.lecture} onChange={(e) => setForm({ ...form, lecture: e.target.value })} placeholder="1, 2, extra…" />
            </Field>
            <Field label="Panopto URL">
              <input className="w-full border rounded-md px-3 py-2 text-sm bg-background" value={form.panopto_url} onChange={(e) => setForm({ ...form, panopto_url: e.target.value })} placeholder="https://…" />
            </Field>
          </div>
          <Field label="Transcript">
            <textarea
              className="input min-h-[200px] font-mono text-xs"
              value={form.transcript_text}
              onChange={(e) => setForm({ ...form, transcript_text: e.target.value })}
              placeholder="[0:00] Speaker: …&#10;[0:12] Speaker: …"
            />
          </Field>
          {err && <div className="text-sm text-destructive">{err}</div>}
          {last && <div className="text-sm text-emerald-600 dark:text-emerald-400">{last}</div>}
          <div className="flex justify-end">
            <Button onClick={submit} disabled={busy || !moduleSlug || !form.transcript_text || !form.panopto_url}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Ingest transcript'}
            </Button>
          </div>
        </CardContent>
      </Card>
      </details>

      <ExistingSourcesList
        title="Existing transcripts"
        sources={sources}
        selected={selected}
        setSelected={setSelected}
        onDelete={async (ids) => {
          for (const id of ids) {
            try { await adminDeleteSource(id) } catch (e) { setErr((e as Error).message) }
          }
          await reloadSources()
          onChange()
        }}
        renderRow={(s) => (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">
                week {s.week} {s.lecture && <Badge variant="secondary" className="ml-1">{s.lecture}</Badge>}
              </div>
              <div className="text-xs text-muted-foreground"><code>{s.code}</code></div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => deleteSource(s.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      />
    </div>
  )
}

// ----------------------------------------------------------------------------
// Shared
// ----------------------------------------------------------------------------

function ModulePicker({ modules, value, onChange }: { modules: AdminModule[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Module:</span>
      <select
        className="input max-w-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {modules.map((m) => (
          <option key={m.id} value={m.slug}>{m.name}</option>
        ))}
      </select>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Bulk transcript importer — CSV manifest + folder of .txt files
// ----------------------------------------------------------------------------

interface BulkRow {
  csvModule: string  // module column from CSV (informational; module slug is set by the picker)
  week: number
  lecture: string
  panopto_url: string
  /** Index of the matched file in the file list, or -1 if no match. */
  fileIndex: number
  /** Resolved filename for display. */
  filename: string | null
  status: 'pending' | 'running' | 'done' | 'error'
  message?: string
}

/** Parse the panopto.csv format: header row then `module,week,lecture,panopto,slides`.
 * The `module` column carries forward — empty cells inherit the previous non-empty value. */
function parseCsv(text: string): { rows: BulkRow[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { rows: [] }
  const rows: BulkRow[] = []
  let currentModule = ''
  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    if (cols.length < 4) continue
    const [mod, weekRaw, lecture, url] = cols
    if (mod.trim()) currentModule = mod.trim()
    const week = parseInt(weekRaw)
    if (!url || !url.trim() || isNaN(week) || !lecture.trim()) continue
    rows.push({
      csvModule: currentModule,
      week,
      lecture: lecture.trim(),
      panopto_url: url.trim(),
      fileIndex: -1,
      filename: null,
      status: 'pending',
    })
  }
  return { rows }
}

/** Try to find a transcript file matching this row.
 *
 * Conventions in this repo:
 *   nc{week}.{lecture}.txt   (NC: explicit week + lecture)
 *   sec{lecture}.txt          (Sec: lecture only — lecture id like "10.1" already encodes everything)
 *   {anything}{week}.{lecture}.txt
 *   {anything}{lecture}.txt
 */
function matchFile(row: BulkRow, files: File[]): number {
  const lec = row.lecture === 'extra' ? '4' : row.lecture
  const candidates = [
    new RegExp(`(^|/)[a-z]+${row.week}\\.${escapeRegex(lec)}\\.txt$`, 'i'),
    new RegExp(`(^|/)[a-z]+${escapeRegex(lec)}\\.txt$`, 'i'),
  ]
  for (let i = 0; i < files.length; i++) {
    const name = files[i].name
    if (candidates.some((re) => re.test(name))) return i
  }
  return -1
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function BulkTranscriptImporter({
  moduleSlug,
  onComplete,
}: {
  moduleSlug: string
  onComplete: () => void | Promise<void>
}) {
  const [csvName, setCsvName] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [rows, setRows] = useState<BulkRow[]>([])
  const [filterCsvModule, setFilterCsvModule] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleCsv = async (file: File) => {
    setErr(null)
    setCsvName(file.name)
    const text = await file.text()
    const { rows: parsed } = parseCsv(text)
    // Default the filter to the first module in the CSV.
    const firstModule = parsed[0]?.csvModule ?? ''
    setFilterCsvModule(firstModule)
    rematch(parsed, files)
  }

  const handleFiles = (fl: FileList) => {
    const arr = Array.from(fl).filter((f) => f.name.endsWith('.txt'))
    setFiles(arr)
    rematch(rows, arr)
  }

  const rematch = (rs: BulkRow[], fs: File[]) => {
    const updated = rs.map((r) => {
      const idx = matchFile(r, fs)
      return { ...r, fileIndex: idx, filename: idx >= 0 ? fs[idx].name : null }
    })
    setRows(updated)
  }

  const visibleRows = rows.filter((r) => !filterCsvModule || r.csvModule === filterCsvModule)
  const matchableCount = visibleRows.filter((r) => r.fileIndex >= 0).length
  const csvModulesSeen = Array.from(new Set(rows.map((r) => r.csvModule))).filter(Boolean)

  const ingestAll = async () => {
    if (!moduleSlug) return
    setRunning(true)
    setErr(null)
    // Iterate through visibleRows but mutate state by row identity (week+lecture).
    for (const row of visibleRows) {
      if (row.fileIndex < 0) continue
      const key = `${row.week}|${row.lecture}`
      setRows((prev) => prev.map((r) =>
        `${r.week}|${r.lecture}` === key && r.csvModule === row.csvModule
          ? { ...r, status: 'running' as const }
          : r
      ))
      try {
        const file = files[row.fileIndex]
        const text = await file.text()
        const res = await adminUploadTranscript({
          module: moduleSlug,
          week: row.week,
          lecture: row.lecture,
          panopto_url: row.panopto_url,
          transcript_text: text,
        })
        setRows((prev) => prev.map((r) =>
          `${r.week}|${r.lecture}` === key && r.csvModule === row.csvModule
            ? { ...r, status: 'done' as const, message: `${res.lines} lines → ${res.chunks_inserted} chunks` }
            : r
        ))
      } catch (e) {
        setRows((prev) => prev.map((r) =>
          `${r.week}|${r.lecture}` === key && r.csvModule === row.csvModule
            ? { ...r, status: 'error' as const, message: (e as Error).message }
            : r
        ))
      }
    }
    setRunning(false)
    await onComplete()
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="text-sm font-medium">Bulk import from CSV + transcript folder</div>
        <p className="text-xs text-muted-foreground">
          Drop a CSV manifest (<code>module,week,lecture,panopto,slides</code>) and select all
          <code className="mx-1">.txt</code> transcript files. The importer matches each row to a file
          by filename convention (<code>nc{'{'}week{'}'}.{'{'}lecture{'}'}.txt</code> or
          <code className="ml-1">sec{'{'}lecture{'}'}.txt</code>) and ingests them in sequence into the
          selected module.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="border border-dashed rounded-md p-3 text-center text-xs hover:border-primary cursor-pointer">
              {csvName ?? 'Drop CSV manifest'}
            </div>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleCsv(e.target.files[0])}
            />
          </label>
          <label className="block">
            <div className="border border-dashed rounded-md p-3 text-center text-xs hover:border-primary cursor-pointer">
              {files.length > 0 ? `${files.length} .txt files selected` : 'Drop transcript .txt files'}
            </div>
            <input
              type="file"
              accept=".txt,text/plain"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
          </label>
        </div>

        {csvModulesSeen.length > 1 && (
          <Field label="Filter CSV module column">
            <select
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              value={filterCsvModule}
              onChange={(e) => setFilterCsvModule(e.target.value)}
            >
              <option value="">(all)</option>
              {csvModulesSeen.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        )}

        {visibleRows.length > 0 && (
          <div className="border rounded-md max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr className="text-left">
                  <th className="px-2 py-1.5">Week</th>
                  <th className="px-2 py-1.5">Lecture</th>
                  <th className="px-2 py-1.5">File match</th>
                  <th className="px-2 py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1">{r.week}</td>
                    <td className="px-2 py-1">{r.lecture}</td>
                    <td className="px-2 py-1 font-mono">
                      {r.filename ?? <span className="text-amber-600 dark:text-amber-400">no match</span>}
                    </td>
                    <td className="px-2 py-1">
                      {r.status === 'pending' && '—'}
                      {r.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
                      {r.status === 'done' && <span className="text-emerald-600 dark:text-emerald-400">{r.message}</span>}
                      {r.status === 'error' && <span className="text-destructive">{r.message}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {err && <div className="text-sm text-destructive">{err}</div>}

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {visibleRows.length > 0 && `${matchableCount}/${visibleRows.length} rows matched`}
          </div>
          <Button
            onClick={ingestAll}
            disabled={running || !moduleSlug || matchableCount === 0}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : `Ingest ${matchableCount} transcripts`}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ExistingSourcesList({
  title,
  sources,
  selected,
  setSelected,
  onDelete,
  renderRow,
}: {
  title: string
  sources: AdminSource[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onDelete: (ids: string[]) => Promise<void>
  renderRow: (s: AdminSource) => React.ReactNode
}) {
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const allSelected = sources.length > 0 && selected.size === sources.length
  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(sources.map((s) => s.id)))
  }

  const deleteSelected = async () => {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} source${selected.size === 1 ? '' : 's'} and all their chunks?`)) return
    await onDelete(Array.from(selected))
    setSelected(new Set())
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
        {sources.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground flex items-center gap-1.5">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              Select all
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={selected.size === 0}
              onClick={deleteSelected}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete {selected.size > 0 ? `(${selected.size})` : ''}
            </Button>
          </div>
        )}
      </div>
      {sources.length === 0 ? (
        <div className="text-sm text-muted-foreground">None yet.</div>
      ) : (
        sources.map((s) => (
          <Card key={s.id}>
            <CardContent className="py-3 flex items-center gap-3">
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
              <div className="flex-1">{renderRow(s)}</div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </label>
  )
}
