# cramkit

> **cramkit** /ˈkramˌkɪt/ *noun.* a self-contained survival pack of past papers, half-remembered lecture notes, and AI tutors, deployed in the panic-stricken weeks before an exam.

AI-powered exam revision built for University of Birmingham students.
Live at **[cramkit.app](https://cramkit.app)**.

---

## What it does

cramkit turns your lecture notes into a personalised revision loop:

- **Ingest** lecture notes (admin only) — Claude extracts ~15–30 concepts per file, tags them by week and module, and generates a bank of MCQ + free-form questions calibrated to past-paper difficulty
- **Quiz** with priority-weighted concept selection — weakest topics first, untested topics, mistakes you've made, or spaced-repetition due
- **Track confidence** per concept with a decay model — your scores fade if you don't revisit, so spaced repetition just works
- **Ask "Why?"** when you get something wrong — opens an inline chatbot grounded in the relevant *lecture moments* (transcripts retrieved via vector search), so the bot can cite which lecture and timestamp explained the topic
- **Filter** quizzes by module, week, mode, and question type (MCQ-only is your offline mode)
- **Modules** page where students enrol in the modules they're studying, request new ones, and vote on existing requests

---

## Architecture

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   Browser   │───▶│  Hono server     │───▶│  Anthropic API   │
│  (React +   │    │  (admin only:    │    │  (admin's key)   │
│   Vite)     │    │   ingestion +    │    └──────────────────┘
│             │    │   transcripts)   │
│             │    └──────────────────┘
│             │              │
│             │              ▼
│             │    ┌──────────────────┐
│             │───▶│    Supabase      │
│             │    │  (Postgres +     │
│             │    │   Auth + RLS)    │
│             │    └──────────────────┘
│             │
│             │    ┌──────────────────┐
│             │───▶│  Anthropic API   │
└─────────────┘    │   (user's key,   │
                   │    BYOK)         │
                   └──────────────────┘
```

- **Frontend** — React + Vite + TypeScript + Tailwind v4 + shadcn/ui. State via Zustand. Theme-aware (dark by default).
- **Backend** — Hono on Node, single Docker container. Serves the built static client AND a small set of admin-only API routes (concept extraction, question generation, lecture transcript embedding + RAG retrieval). All admin routes validate the Supabase JWT and check the caller's email against the admin allow-list.
- **Database** — Supabase (managed Postgres). Tables: `exams`, `concepts`, `questions`, `knowledge`, `revision_slots`, `module_enrollments`, `module_requests`, `module_request_votes`, `lectures`, `lecture_chunks`. Row-level security enforces per-user knowledge isolation; concepts and questions are global course material that any authenticated user can read.
- **AI calls** — split into two paths:
  - **Realtime** (BYOK) — quiz evaluation and "Why?" chat run directly from the browser using each user's own Anthropic key. cramkit's servers never see the key. Powered by `claude-sonnet-4-6`.
  - **Batch** (admin only) — concept extraction, question generation, and transcript embedding run on the server using cramkit's key. Same model.
- **Auth** — Supabase magic-link via Resend SMTP, sending from `noreply@cramkit.app`. No passwords. (University of Birmingham mail servers currently filter these so we recommend personal email addresses.)
- **Reverse proxy** — Caddy on a Debian VPS handles TLS via Let's Encrypt and routes `cramkit.app` to the cramkit container over a dedicated Docker network.

---

## Repo layout

```
cramkit/
├── client/                       # Vite + React frontend
│   ├── public/
│   │   ├── logos/                # Brand marks (light + dark)
│   │   └── ...                   # Favicons + manifest
│   └── src/
│       ├── components/
│       │   ├── auth/             # Login + setup wizard
│       │   ├── dashboard/        # Exam countdowns, confidence, allocation
│       │   ├── modules/          # Enrol + request modules
│       │   ├── quiz/             # The main loop
│       │   ├── progress/         # Per-concept progress browser
│       │   ├── chat/             # Standalone "Learn" chat + lecture-grounded chat
│       │   ├── ingestion/        # Admin: notes upload + concept review
│       │   ├── schedule/         # Admin: revision slot calendar
│       │   ├── settings/         # API key + account
│       │   └── layout/           # AppShell, sidebar, theme toggle, logo
│       ├── lib/                  # supabase, anthropic, auth, theme, citations
│       ├── store/                # Zustand store + selectors + hydration
│       ├── services/             # quiz selection, ingestion pipeline
│       └── hooks/
│
├── server/                       # Hono API server
│   └── src/
│       ├── routes/
│       │   ├── ingestion.ts      # extract concepts, dedup, generate questions
│       │   └── lectures.ts       # transcript ingest + RAG search
│       └── lib/
│           ├── anthropic.ts
│           └── auth.ts           # Supabase JWT validation middleware
│
├── supabase/
│   └── migrations/               # Schema, RLS policies, seed data
│
├── scripts/
│   └── migrate-to-supabase.mjs   # one-time SQLite → Supabase migration
│
├── Dockerfile                    # Multi-stage: build client + server, runtime serves both
├── docker-compose.yml            # Single container, joins cramkit_net
└── README.md
```

---

## Local development

```bash
# Install deps
npm install
cd client && npm install
cd ../server && npm install

# Set up your env files
cat > server/.env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
PORT=3001
CORS_ORIGINS=http://localhost:5173
EOF

cat > client/.env.local <<'EOF'
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
EOF

# Run both client and server
npm run dev
```

Client at `http://localhost:5173`, server at `http://localhost:3001`. Vite proxies `/api/*` to the server.

---

## Deploying

The app runs as a single Docker container behind a Caddy reverse proxy on a Debian VPS.

```bash
# Push your changes
git push

# On the VPS
ssh debian@your-vps
cd ~/cramkit
git pull
docker compose up -d --build
```

The Caddyfile (in a separate `vps-caddy-config` repo) routes `cramkit.app` and `www.cramkit.app` to the `cramkit` container over a dedicated `cramkit_net` Docker network.

---

## Key design decisions

- **Concepts and questions are global, not per-user.** Once an admin ingests notes for a module, every enrolled user sees the same concept bank. Knowledge tracking (confidence scores, attempt history) is per-user. This is the only thing that scales to multiple students.
- **BYOK for realtime AI.** Each user pays for their own Claude usage. Sustainable for a free tool, no platform-side cost surprises. A future Stripe subscription is wired into the setup wizard but disabled.
- **Lecture transcripts as a RAG layer.** When a student gets a question wrong, the "Why?" chatbot retrieves the most relevant lecture moments via vector search and grounds Claude's explanation in the actual recordings — with clickable Panopto deep-links that open at the right timestamp.
- **Open signups.** We tried gating to `bham.ac.uk` but the university's mail server filters our login emails, so the practical move was to drop the gate. Anyone can sign up; the modules and concepts assume a Birmingham CS context but nothing breaks for non-students.
- **Dark mode by default.** Set inline in `index.html` before React mounts so there's no flash of light mode.
- **DM Sans + Dosis** as the type pair, both self-hosted via Fontsource. No third-party font requests.
