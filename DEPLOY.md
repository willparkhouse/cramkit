# Cramkit deployment

## One-time setup

### 1. Run the schema migration in Supabase

1. Go to https://fymhczfibfbchpmgyfkq.supabase.co → **SQL Editor** → **New query**
2. Paste the contents of `supabase/migrations/001_initial_schema.sql`
3. Click **Run**
4. Verify the tables exist in **Table editor**: `exams`, `concepts`, `questions`, `knowledge`, `revision_slots`

### 2. Migrate your existing SQLite data

```bash
cd /Users/wjdparkhouse/code/revision
SUPABASE_SECRET_KEY="<your-supabase-secret-key>" \
  USER_EMAIL="<your-email>" \
  node scripts/migrate-to-supabase.mjs
```

Get the secret key from Supabase Dashboard → Settings → API → `service_role` key.

This:
- Creates a Supabase user for your email if one doesn't exist
- Copies all 76 concepts, 442 questions, knowledge history, and 81 revision slots
- Maps the old SQLite exam IDs to the new Supabase ones

### 3. Configure DNS

Point `cramkit.app` and `www.cramkit.app` to your VPS IP `57.128.176.88`:

| Type | Name | Value |
|------|------|-------|
| A    | @    | 57.128.176.88 |
| A    | www  | 57.128.176.88 |

## Deploying to the VPS

### First-time deploy

```bash
# Sync the codebase to the VPS (use rsync, ignoring node_modules / db)
rsync -avz --exclude node_modules --exclude '.git' --exclude 'server/data' \
  --exclude 'client/dist' --exclude 'server/dist' \
  -e "ssh -i ~/.ssh/id_ed25519" \
  /Users/wjdparkhouse/code/revision/ \
  debian@57.128.176.88:~/cramkit/

# Push the updated Caddyfile + caddy compose
rsync -avz -e "ssh -i ~/.ssh/id_ed25519" \
  /Users/wjdparkhouse/code/vps-caddy-config/ \
  debian@57.128.176.88:~/caddy-repo/

# SSH in and bring everything up
ssh -i ~/.ssh/id_ed25519 debian@57.128.176.88
```

On the VPS:

```bash
# Build and start cramkit (creates the cramkit_net network)
cd ~/cramkit
docker compose up -d --build

# Restart caddy to pick up new Caddyfile + new network
cd ~/caddy-repo
docker compose down
docker compose up -d
```

### Subsequent deploys

```bash
rsync -avz --exclude node_modules --exclude '.git' --exclude 'server/data' \
  --exclude 'client/dist' --exclude 'server/dist' \
  -e "ssh -i ~/.ssh/id_ed25519" \
  /Users/wjdparkhouse/code/revision/ \
  debian@57.128.176.88:~/cramkit/

ssh -i ~/.ssh/id_ed25519 debian@57.128.176.88 \
  'cd ~/cramkit && docker compose up -d --build'
```

## Architecture summary

- **Database**: Supabase (managed Postgres + Auth)
- **Frontend**: Built into Hono server's `/public` directory, served as static files
- **Backend (Hono)**: One container, port 3001 internally
  - `/api/health` — health check
  - `/api/extract-concepts` — Anthropic ingestion (server's key)
  - `/api/deduplicate` — Anthropic ingestion (server's key)
  - `/api/generate-questions` — Anthropic ingestion (server's key)
  - All `/api/*` ingestion routes require valid Supabase JWT
- **AI calls (realtime)**: BYOK — quiz evaluation and "Why?" chat go directly from the browser to Anthropic with the user's own API key (entered in Settings)
- **Auth**: Supabase magic link, restricted to `*.bham.ac.uk` emails (enforced by DB trigger and middleware)
- **Reverse proxy**: Existing Caddy on the VPS routes `cramkit.app` → `cramkit:3001` over the `cramkit_net` Docker network
