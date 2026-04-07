#!/usr/bin/env node
/**
 * One-time migration: SQLite → Supabase
 *
 * Reads concepts, questions, knowledge, and revision_slots from the local
 * SQLite DB and inserts them into Supabase, assigning all rows to the
 * specified user.
 *
 * Usage:
 *   SUPABASE_SECRET_KEY=sb_secret_... \
 *   USER_EMAIL=you@bham.ac.uk \
 *   node scripts/migrate-to-supabase.mjs
 */

import Database from 'better-sqlite3'
import { createClient } from '@supabase/supabase-js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = 'https://fymhczfibfbchpmgyfkq.supabase.co'
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY
const USER_EMAIL = process.env.USER_EMAIL

if (!SECRET_KEY) {
  console.error('ERROR: SUPABASE_SECRET_KEY env var required')
  process.exit(1)
}
if (!USER_EMAIL) {
  console.error('ERROR: USER_EMAIL env var required (your bham.ac.uk email)')
  process.exit(1)
}

const dbPath = path.join(__dirname, '..', 'server', 'data', 'revision.db')
console.log(`Reading SQLite db: ${dbPath}`)
const db = new Database(dbPath, { readonly: true })

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ============================================================================
// Find or create the user
// ============================================================================
console.log(`\nLooking up user: ${USER_EMAIL}`)
const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers()
if (usersError) {
  console.error('Failed to list users:', usersError.message)
  process.exit(1)
}

let user = usersData.users.find((u) => u.email === USER_EMAIL)
if (!user) {
  console.log(`User not found. Creating ${USER_EMAIL}...`)
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: USER_EMAIL,
    email_confirm: true,
  })
  if (createError) {
    console.error('Failed to create user:', createError.message)
    process.exit(1)
  }
  user = created.user
}

console.log(`User ID: ${user.id}`)

// ============================================================================
// Map old SQLite exam IDs to Supabase exam IDs (by name)
// ============================================================================
console.log('\nFetching exams from Supabase...')
const { data: supabaseExams, error: examsError } = await supabase
  .from('exams')
  .select('id, name')

if (examsError) {
  console.error('Failed to fetch exams:', examsError.message)
  process.exit(1)
}

const sqliteExams = db.prepare('SELECT id, name FROM exams').all()
const examIdMap = new Map()
for (const sqlExam of sqliteExams) {
  const match = supabaseExams.find((e) => e.name === sqlExam.name)
  if (match) {
    examIdMap.set(sqlExam.id, match.id)
    console.log(`  ${sqlExam.name}: ${sqlExam.id} → ${match.id}`)
  } else {
    console.warn(`  No Supabase exam found for "${sqlExam.name}"`)
  }
}

// ============================================================================
// Migrate concepts
// ============================================================================
console.log('\nMigrating concepts...')
const sqliteConcepts = db.prepare('SELECT * FROM concepts').all()
console.log(`  Found ${sqliteConcepts.length} concepts in SQLite`)

const conceptIdMap = new Map() // old SQLite UUID → new Supabase UUID
const conceptRows = sqliteConcepts.map((c) => {
  const oldModuleIds = JSON.parse(c.module_ids || '[]')
  const newModuleIds = oldModuleIds.map((id) => examIdMap.get(id)).filter(Boolean)
  return {
    user_id: user.id,
    name: c.name,
    description: c.description,
    key_facts: JSON.parse(c.key_facts || '[]'),
    module_ids: newModuleIds,
    difficulty: c.difficulty,
    source_excerpt: c.source_excerpt,
    week: c.week,
    lecture: c.lecture,
    _old_id: c.id,
  }
})

// Insert in batches of 100
const insertedConcepts = []
for (let i = 0; i < conceptRows.length; i += 100) {
  const batch = conceptRows.slice(i, i + 100).map(({ _old_id, ...row }) => row)
  const { data, error } = await supabase.from('concepts').insert(batch).select()
  if (error) {
    console.error(`  Batch ${i / 100} failed:`, error.message)
    process.exit(1)
  }
  // Map old IDs to new
  for (let j = 0; j < data.length; j++) {
    conceptIdMap.set(conceptRows[i + j]._old_id, data[j].id)
    insertedConcepts.push(data[j])
  }
  console.log(`  Inserted ${insertedConcepts.length}/${conceptRows.length}`)
}

// ============================================================================
// Migrate questions
// ============================================================================
console.log('\nMigrating questions...')
const sqliteQuestions = db.prepare('SELECT * FROM questions').all()
console.log(`  Found ${sqliteQuestions.length} questions in SQLite`)

const questionRows = sqliteQuestions
  .map((q) => {
    const newConceptId = conceptIdMap.get(q.concept_id)
    if (!newConceptId) return null
    return {
      user_id: user.id,
      concept_id: newConceptId,
      type: q.type,
      difficulty: q.difficulty,
      question: q.question,
      options: q.options ? JSON.parse(q.options) : null,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      source: q.source || 'batch',
      times_used: q.times_used || 0,
    }
  })
  .filter(Boolean)

let insertedQuestionCount = 0
for (let i = 0; i < questionRows.length; i += 200) {
  const batch = questionRows.slice(i, i + 200)
  const { error } = await supabase.from('questions').insert(batch)
  if (error) {
    console.error(`  Batch ${i / 200} failed:`, error.message)
    process.exit(1)
  }
  insertedQuestionCount += batch.length
  console.log(`  Inserted ${insertedQuestionCount}/${questionRows.length}`)
}

// ============================================================================
// Migrate knowledge
// ============================================================================
console.log('\nMigrating knowledge...')
const sqliteKnowledge = db.prepare('SELECT * FROM knowledge').all()
console.log(`  Found ${sqliteKnowledge.length} knowledge entries in SQLite`)

const knowledgeRows = sqliteKnowledge
  .map((k) => {
    const newConceptId = conceptIdMap.get(k.concept_id)
    if (!newConceptId) return null
    return {
      user_id: user.id,
      concept_id: newConceptId,
      score: k.score,
      last_tested: k.last_tested,
      history: JSON.parse(k.history || '[]'),
      updated_at: k.updated_at || new Date().toISOString(),
    }
  })
  .filter(Boolean)

if (knowledgeRows.length > 0) {
  const { error } = await supabase.from('knowledge').insert(knowledgeRows)
  if (error) {
    console.error('  Knowledge insert failed:', error.message)
    process.exit(1)
  }
  console.log(`  Inserted ${knowledgeRows.length} knowledge entries`)
}

// ============================================================================
// Migrate revision slots
// ============================================================================
console.log('\nMigrating revision slots...')
const sqliteSlots = db.prepare('SELECT * FROM revision_slots').all()
console.log(`  Found ${sqliteSlots.length} slots in SQLite`)

const slotRows = sqliteSlots.map((s) => ({
  user_id: user.id,
  start_time: s.start_time,
  end_time: s.end_time,
  allocated_module_id: examIdMap.get(s.allocated_module_id) || null,
  calendar_event_id: s.calendar_event_id,
  status: s.status || 'pending',
}))

if (slotRows.length > 0) {
  const { error } = await supabase.from('revision_slots').insert(slotRows)
  if (error) {
    console.error('  Slot insert failed:', error.message)
    process.exit(1)
  }
  console.log(`  Inserted ${slotRows.length} slots`)
}

console.log('\n✓ Migration complete!')
console.log(`  Concepts: ${insertedConcepts.length}`)
console.log(`  Questions: ${insertedQuestionCount}`)
console.log(`  Knowledge: ${knowledgeRows.length}`)
console.log(`  Slots: ${slotRows.length}`)
