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

```bash
npm install
npx prisma db push --schema prisma/schema.prisma   # create the SQLite database
node scripts/seed-accounts.mjs                     # seed entities, accounts and funds
npm run dev                                        # http://localhost:3000
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
| `npm test` | Accounting integrity and backup tests (Vitest) |
| `npm run prisma:push` | Apply `prisma/schema.prisma` to the database |
| `npm run prisma:seed` | Seed entities, chart of accounts and funds |
| `npm run lint` | **Currently broken** — see below |

`npm run lint` runs `next lint`, which was removed in Next.js 16. The project also has an `.eslintrc.json` extending `next/core-web-vitals`, but `eslint-config-next` is not installed, and the installed ESLint 9 expects flat config (`eslint.config.mjs`) rather than `.eslintrc.*`. Three separate breaks, so there is currently no working linter. Type checking still works via `npx tsc --noEmit`.

## Environment

Copy `.env.example` to `.env`. Relevant variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite connection. A relative `file:` URL resolves against the **schema directory** (`prisma/`), not the working directory — so `file:./dev.db` means `prisma/dev.db`. |
| `BACKUP_DIR` | Where database backups are written. Defaults to `backups/` next to the database; point it at separate durable storage. |

`.env` is git-ignored and holds real credentials. Never commit it.

## Where things live

```text
src/app/              App Router entry, layout, and API routes (audit, backups)
src/components/app/   app-shell.tsx — the entire UI, single shell with sidebar nav
src/components/ui/    Design system primitives (Button, Card, Input, Money, Badge)
src/lib/              Shared logic (see below)
src/instrumentation.ts  Server boot hook — starts the nightly backup scheduler
prisma/               Schema and the SQLite database file
scripts/              Seed scripts
tests/                Vitest suites
public/               Static assets
```

The files worth reading first in `src/lib/`:

- **`ghana-tax.ts`** — the statutory levy rule. Single source of truth, shared by the document form, the journal builder, the tax report and the tests.
- **`accounting-integrity.ts`** — the invariants the books must satisfy (journals balance, trial balance nets to zero, balance sheet balances, intercompany postings mirror faithfully). Exercised by the tests; the shell does not import it.
- **`report-data.ts`** — the demo ledger, projects and account classifications that the reports currently read from.
- **`backup.ts`** — SQLite online backup, checksum verification, retention.
- **`audit.ts`** — append-only audit log with a SHA-256 hash chain per entity.

## A caution on the current state

The UI reads its accounting data from the module-level arrays in `report-data.ts`, not from the database. The Prisma schema is real and seeded, but only the audit log and backups actually round-trip through it. Funds and projects consequently exist in two places at once. Persisting documents and journals is the main outstanding work — see the known gaps in [PROJECT_STATE.md](PROJECT_STATE.md).

There is also no deploy configuration. The pre-rebuild Flask app and its Render config were removed in `38ed586`, and nothing has replaced them — the new config depends on whether the datasource stays SQLite or moves to Postgres.
