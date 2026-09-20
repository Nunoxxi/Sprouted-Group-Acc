# Sprouted Group Accounting App

A multi-entity accounting web app for Sprouted Group — three Ghanaian companies that trade with each other constantly:

- **Sprouted Roots** — farmer programs and raw material aggregation; this is the charity, and the only entity using fund and project reporting
- **Sprouted Crafts** — cashew processing
- **Oikazi** — cocoa processing

Read [CLAUDE.md](CLAUDE.md) before writing any code — it holds the non-negotiable accounting rules. [PROJECT_STATE.md](PROJECT_STATE.md) describes what is built, in detail, and what the known gaps are.

## The rules that constrain every change

These are not preferences. Breaking one is a bug, not a style disagreement.

- Every record carries an `entityId`, and every query is entity-scoped **by default** — failing closed, not falling back to all entities. Adding a fourth entity must require no schema change.
- Accounting is double-entry. Every transaction posts balanced money in and money out to a journal. Nothing is hard-deleted; corrections are reversing entries.
- Money is stored as **integer pesewas**, never floating point. Currency is Ghana cedi (GHS).
- Ghana VAT is 20% effective: 15% VAT + 2.5% NHIL + 2.5% GETFund, all on the same base, all recoverable as input tax. They are assessed and recovered separately, so each is rounded independently. This rule lives in `src/lib/ghana-tax.ts` and must not be reimplemented anywhere else.
- Users are not accountants. The interface says "money in" and "money out", never "debit" and "credit".

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 3.4 · Prisma 6 + SQLite · Vitest

> This version of Next.js has breaking changes from earlier ones. The bundled docs in `node_modules/next/dist/docs/` are the authority — check them before relying on anything remembered about Next.

## Run it locally

You need a Postgres database — Supabase, or a local one. Copy `.env.example` to `.env` and fill in the two connection strings (the file explains which is which).

```bash
npm install                  # also generates the Prisma client
npx prisma migrate deploy    # apply prisma/migrations
npm run prisma:seed          # entities, charts of accounts, contacts, funds, projects
npm run dev                  # http://localhost:3000
```

On Windows PowerShell you may first need:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm test` | Accounting integrity, audit chain and export tests (Vitest); none need a database |
| `npm run lint` | ESLint (flat config, Next core-web-vitals + TypeScript presets) |
| `npm run prisma:deploy` | Apply pending migrations (what production runs) |
| `npm run prisma:migrate` | Create a migration from a schema change and re-seed (development) |
| `npm run prisma:seed` | Seed entities, charts of accounts, contacts, funds, projects — idempotent |

Type checking: `npx tsc --noEmit`.

## Environment

Copy `.env.example` to `.env`. Relevant variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres, **transaction pooler** (Supabase port 6543, `?pgbouncer=true`). Used by the running app. |
| `DIRECT_URL` | Postgres, **session pooler** (port 5432 on the same pooler host). Used only by `prisma migrate`. Not Supabase's "Direct connection", which is IPv6-only on most tiers. |
| `EXPORT_DIR` | Where ledger export files are written. Defaults to `exports/` next to the app; point it at durable storage in production. |

`.env` is git-ignored and holds real credentials. Never commit it.

## Where things live

```text
src/app/              App Router entry, layout, and API routes (audit, backups)
src/components/app/   app-shell.tsx — the entire UI, single shell with sidebar nav
src/components/ui/    Design system primitives (Button, Card, Input, Money, Badge)
src/lib/              Shared logic (see below)
src/lib/data/         The Prisma boundary: mappers, enum translation, bigint → number
src/instrumentation.ts  Server boot hook — starts the nightly export scheduler
prisma/               Schema and migrations
scripts/              Seed script (runs under plain Node 24)
tests/                Vitest suites
render.yaml           Render deployment
public/               Static assets
```

The files worth reading first in `src/lib/`:

- **`ghana-tax.ts`** — the statutory levy rule. Single source of truth, shared by the document form, the journal builder, the tax report and the tests.
- **`data/money.ts`** — `toMinor` / `fromMinor`. Money is `BigInt` in Postgres and `number` everywhere else; this is the only place the two meet.
- **`accounting-integrity.ts`** — the invariants the books must satisfy (journals balance, trial balance nets to zero, balance sheet balances, intercompany postings mirror faithfully). Exercised by the tests; the shell does not import it.
- **`seed-data.ts`** — the demo entities, contacts, funds and projects. The seed writes them; nothing else defines them.
- **`report-data.ts`** — the demo ledger and account classifications that the reports currently read from.
- **`export.ts`** — per-entity ledger export, checksum verification, retention.
- **`audit.ts`** — append-only audit log with a SHA-256 hash chain per entity; runs inside the caller's transaction when given one.

## A caution on the current state

Entities, contacts, charts of accounts, invoices, bills, journals, filed periods, the audit log and exports all live in Postgres and round-trip through it. **Reports, the VAT return, intercompany, bank reconciliation and the dashboard do not yet** — they still read demo arrays in `report-data.ts` and the shell, so a document you post is in the ledger but not on any report. Pointing the reports at the ledger is the next pass; see [PROJECT_STATE.md](PROJECT_STATE.md).

**There is no authentication.** Every server function is reachable by direct POST. Do not deploy this anywhere untrusted until that is done. `render.yaml` describes the deployment; nothing has been deployed yet.
