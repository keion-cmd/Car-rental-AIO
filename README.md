# Car-rental-AIO

## Local setup

This project is **local-first**: the remote Supabase Postgres project's
direct-connect host is IPv6-only, which repeatedly blocked development
(four phases were lost to this before the project switched to a local
database by default). Do not depend on reaching the remote database for
day-to-day development.

**Database method:** an embedded, real PostgreSQL binary (the
`embedded-postgres` package, not an emulation — it ships actual
`postgres`/`initdb` executables) is used as a devDependency. It requires no
Docker daemon and no separately installed Postgres service. Docker
Desktop is not a hard prerequisite for local development; if it becomes
available in the future, `supabase start` (Supabase CLI local dev, which
runs the same Postgres you'd get from Docker Compose) is the preferred
alternative — see `scripts/local-db.ts` and `tests/global-setup.ts` for
where the swap would happen.

Start it manually:

```bash
npx tsx scripts/local-db.ts start
npx tsx scripts/local-db.ts stop
```

Data persists in the gitignored `.pgdata/` directory at the repo root, on
port `54329`, database `car_rental_dev`.

Running `npm test` (vitest) starts the local Postgres automatically via
`tests/global-setup.ts` if it isn't already running, applies pending
Prisma migrations, runs the suite, and stops it again if this process is
the one that started it.

**Migrations:** Prisma is the single migration authority for this
project. Never run `supabase migration new`, `supabase db diff`,
`supabase db push`, or `supabase link` — those commands must not be used
here. Use `npx prisma migrate dev` / `npx prisma migrate deploy` /
`npx prisma migrate status` instead. `supabase init`, `supabase start`,
`supabase stop`, and `supabase status` remain fine to use if the project
later adopts Supabase CLI local dev (Method 1 above).

**Env vars:** `DATABASE_URL` and `DIRECT_URL` in `.env.local` point at the
local database (no pooler locally, so both share the same value). The
original remote connection strings are preserved under
`REMOTE_DATABASE_URL` / `REMOTE_DIRECT_URL` for the eventual
remote-deployment phase — they are not read by the app or by Prisma
today.

**Row-level security (RLS):** deferred to the remote-deployment phase.
RLS is meaningless against a local, single-user development database and
is not configured here.
