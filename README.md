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
- Money is stored as **integer minor units** (pesewas, cents), never floating point. Each entity keeps its books in its own functional currency (GHS by default); every journal line also carries its transaction currency, amount and the rate used, fixed at posting. Rates are exact decimals applied with integer arithmetic.
- Ghana VAT is 20% effective: 15% VAT + 2.5% NHIL + 2.5% GETFund, all on the same base, all recoverable as input tax. They are assessed and recovered separately, so each is rounded independently. This rule lives in `src/lib/ghana-tax.ts` and must not be reimplemented anywhere else. **VAT registration is per entity and off by default** — none of the group is registered yet. While an entity is unregistered nothing is taxed and VAT on purchases is part of the cost; when an Owner switches it on with a date, VAT applies to that entity's documents dated on or after that date, never earlier.
- Users are not accountants. The interface says "money in" and "money out", never "debit" and "credit".

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 3.4 · Prisma 6 + Postgres (Supabase) · Vitest

> This version of Next.js has breaking changes from earlier ones. The bundled docs in `node_modules/next/dist/docs/` are the authority — check them before relying on anything remembered about Next.

## Run it locally

You need a Postgres database — Supabase, or a local one. Copy `.env.example` to `.env` and fill in the two connection strings (the file explains which is which).

```bash
npm install                  # also generates the Prisma client
npx prisma migrate deploy    # apply prisma/migrations
npm run prisma:seed          # entities, charts of accounts, contacts, funds, projects
npm run auth:create-owner -- --email you@example.com --name "Your Name"
npm run dev                  # http://localhost:3000
```

There is no sign-up page. The command above creates the first Owner without a password; open `/forgot-password`, enter that email, and set one from the link (printed to the dev server console when no email transport is configured). Owners and Accountants are asked to set up an authenticator app on first sign-in. Everyone else is invited from **/admin/users**.

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
| `BETTER_AUTH_SECRET` | Signs session cookies and encrypts TOTP secrets. `openssl rand -base64 32`. Changing it signs everyone out. |
| `BETTER_AUTH_URL` | The app's public URL; invite and reset links are built from it. |
| `PII_ENCRYPTION_KEY` | 32 random bytes, base64, encrypting telephone numbers, mobile money numbers, addresses, email addresses and signatures before they are stored. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep a copy somewhere safe: change it or lose it and every encrypted value becomes unreadable (the financial records are unaffected). |
| `RESEND_API_KEY`, `EMAIL_FROM` | Outbound email for invitations and resets. `EMAIL_FROM` is the group sender and its domain is the one verified with Resend; each entity may set its own sender on that domain under Settings. Without a key, development prints the email to the console; production refuses to send. |

`.env` is git-ignored and holds real credentials. Never commit it.

## Where things live

```text
src/app/              App Router entry, layout, and API routes (audit, backups)
src/components/app/   app-shell.tsx — the UI shell with sidebar nav; inventory-panel.tsx — Inventory; buying-panel.tsx — agents and floats; contracts-panel.tsx — sales contracts and LBC; opening-panel.tsx — go-live; payments-panel.tsx — wallets, statements, farmer payments; grants-panel.tsx — grants, budgets, donor reports; cashflow-panel.tsx — 13-week and 12-month forecasts; assets-panel.tsx — the register, depreciation and the tax computation; payroll-panel.tsx — the payroll import and its liabilities; inbox-panel.tsx — the attachment inbox and its rules; privacy-panel.tsx — the register of personal data, subject access requests and erasure
src/app/field/        The buying agent's phone form: mobile-first, works offline, syncs when it can
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

- **`ghana-tax.ts`** — the statutory levy rule, the registration rule (`vatAppliesOn`) and the GHS 750,000 threshold. Single source of truth, shared by the document form, the journal builder, the tax report and the tests.
- **`data/money.ts`** — `toMinor` / `fromMinor`. Money is `BigInt` in Postgres and `number` everywhere else; this is the only place the two meet.
- **`accounting-integrity.ts`** — the invariants the books must satisfy (journals balance, trial balance nets to zero, balance sheet balances, intercompany postings mirror faithfully). Exercised by the tests; the shell does not import it.
- **`seed-data.ts`** — the demo entities, contacts, funds and projects. The seed writes them; nothing else defines them.
- **`report-data.ts`** — the demo ledger and account classifications that the reports currently read from.
- **`export.ts`** — per-entity ledger export, checksum verification, retention.
- **`inventory.ts`** — stock: grams as the unit of weight, weighted average cost as value ÷ quantity per grade per location, receipt allocation from bills, adjustment/transfer/write-down journals, count differences, NRV, and the stock-to-ledger reconciliation. Pure and fully tested.
- **`momo.ts`** — mobile money and farmer payments: statement parsing against a column mapping with the fee and levy split off each line, the charges and settlement journals, advance recovery, batch matching, the disbursement export and the farmer's history. Pure and fully tested.
- **`attachments.ts`** — attachments: what may be uploaded, how a photograph is reduced, the storage key, the posting gate, what may be removed, and matching an inbox file. Pure and fully tested. The storage client itself is `src/lib/storage.ts`.
- **`payroll.ts`** — the payroll import: reading a summary against its mapping and checking it adds up, splitting a person's cost across grants, the month's journal, and the liabilities with their due dates. No payroll is computed anywhere. Pure and fully tested.
- **`assets.ts`** — fixed assets and tax: straight-line and reducing-balance depreciation landing on the residual, the disposal gain or loss, capital allowance pools on classes that are settings, the tax computation, and the provisional instalments. Pure and fully tested.
- **`cashflow.ts`** — cash flow forecasting: the week and month buckets, the buying-season curve, flows from documents, contracts, grants and recurring costs, balances per currency and combined, the minimum-cash flag, scenarios side by side and the group. Pure and fully tested.
- **`grants.ts`** — grant management: the donor's reporting periods, budget against actual in both currencies with overspend and underspend flags, the receipt, release, in-kind and staff-time journals, and how much deferred income may be released. Pure and fully tested.
- **`opening.ts`** — opening balances: the trial-balance check, control accounts redirected to suspense, detail journals against it, and the go-live checklist. Pure and fully tested.
- **`contracts.ts`** — sales contracts: values, margin per contract at the contract rate and today's, FX exposure on the open balance, the position report, and every delivery journal shape including LBC gross and net. Pure and fully tested.
- **`trading.ts`** — commodity trading: landed cost per kilogram, shrinkage within and beyond tolerance, buying-agent floats and their reconciliation, quality fields per commodity. Pure and fully tested.
- **`fx.ts`** — multi-currency: exact rate arithmetic, rate selection, journal conversion, realised FX on settlement, period-end revaluation, intercompany across currencies. Pure and fully tested.
- **`audit.ts`** — append-only audit log with a SHA-256 hash chain per entity; runs inside the caller's transaction when given one.
- **`privacy.ts`** — the register of every field in the app that is about a person, who may see it, how numbers are masked, and what erasure does and does not touch. Pure and fully tested; it is what [DATA-PROTECTION.md](DATA-PROTECTION.md) is written from.
- **`pii-crypto.ts`** — AES-256-GCM for the personal details, with the field's own name bound into the ciphertext so a value cannot be moved between columns.
- **`authz.ts`** — the role matrix and entity-access rules. Pure; every decision about who may do what comes from here.
- **`dal.ts`** — turns the session into a principal and refuses anything not allowed. Every server function and route handler starts here.
- **`auth.ts`** — the Better Auth configuration: the library owns passwords, sessions, tokens, TOTP and rate limits; hooks add the ten-failure lock and the deactivation check.

## A caution on the current state

Entities, contacts, charts of accounts, invoices, bills, journals, filed periods, the audit log and exports all live in Postgres and round-trip through it. **Reports, the VAT return, intercompany, bank reconciliation and the dashboard do not yet** — they still read demo arrays in `report-data.ts` and the shell, so a document you post is in the ledger but not on any report. Pointing the reports at the ledger is the next pass; see [PROJECT_STATE.md](PROJECT_STATE.md).

**Personal data is encrypted, masked and logged.** What the app holds about farmers, agents, staff and the people it trades with, where it is stored, who can see it and what happens when somebody asks for a copy or asks to be erased is written out in plain language in [DATA-PROTECTION.md](DATA-PROTECTION.md), for the registration with Ghana's Data Protection Commission.

**Authentication is built in** (Better Auth): invite-only email + password, mandatory TOTP for roles that can post, five roles (Owner, Accountant, Bookkeeper, Data entry, Viewer), per-entity access checked on every server function and route, an Owner-only users and sessions screen. See PROJECT_STATE.md. `render.yaml` describes the deployment; nothing has been deployed yet. Before deploying, set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and an email transport (`RESEND_API_KEY`, `EMAIL_FROM`) — invitations cannot be sent without one.
