# Sprouted Group — Project State

Read [CLAUDE.md](CLAUDE.md) first — it contains the non-negotiable accounting rules. This file describes where the project stands right now, for any developer or AI picking it up.

## Stack

- Next.js 16.3.5 (App Router) + React 19 + TypeScript
- Tailwind CSS 3.4 (Xero-inspired warm neutral design system in `src/app/globals.css` and `src/components/ui/`)
- Prisma 6 + **Postgres** (`prisma/schema.prisma`, migrations in `prisma/migrations/`). Hosted on Supabase; a local Postgres works identically. See `.env.example` for which connection string is which — the transaction pooler for the app, the session pooler for migrations.
- Vitest (`npm test`) — no test touches a database.
- ESLint flat config (`eslint.config.mjs`); `npm run lint`.

## What is built

All current UI lives in `src/components/app/app-shell.tsx` (single shell, sidebar navigation). Each module:

- **Dashboard** — cash position, money owed to us, money we owe, intercompany balance; shared contacts with per-entity balances; entity switcher; add-entity form
- **Sales / Purchases** — Xero-style invoice and bill editor. Line items with description, quantity, unit price (entered in cedis, stored in pesewas), account code, VAT treatment (standard / zero-rated / exempt). Ghana VAT split: 15% VAT + 2.5% NHIL + 2.5% GETFund on the same base, shown separately. Bills withhold WHT (5%/10%) based on the supplier's status and show net payable. Status flow: draft → awaiting payment → paid, plus voided. Every document generates a balanced journal (collapsible panel). Autosaves to localStorage. E-VAT placeholder fields (clearance number, QR code, timestamp) exist on invoices — no GRA integration yet.
- **Bank** — CSV import with first-import column mapping saved per bank; two-column reconciliation (bank lines left, suggested matches right) with confidence scores from amount/date/contact; keyboard operated (arrows + Enter); in-row account coding; bulk match for repeated identical transactions; undo match; unreconciled counter.
- **Intercompany** — one entry posts both sides: sales invoice on the source entity and mirrored purchase bill on the target, linked by a shared reference. Group balance matrix across all entities (scales past three) with mismatch highlighting. Related-party report with both journal entries side by side.
- **Tax** — per-entity VAT return per period (output VAT, input VAT, NHIL, GETFund, net position), every figure clickable to drill into transactions. Filing a period locks it — documents dated in a filed period cannot change status; corrections must be reversing adjustments in the current period. WHT report per supplier with TIN and CSV export for GRA.
- **Reports** — trial balance, profit & loss, balance sheet, cash flow, aged receivables, aged payables. All take a date range, are entity-scoped, include a prior-period comparison column, and every figure drills into the underlying ledger lines. Fund report (restricted/unrestricted, closing balance per fund) for Sprouted Roots only. **Project tracking** (Reports → Projects): each Sprouted Roots project (funder, restricted/unrestricted fund, budget) shows opening balance, funds received, expenses and closing balance per period with a budget-usage bar, all clickable to transactions; CSV export. Group view with all entities side by side plus a total column, clearly labelled as a management summary (not statutory consolidation, no eliminations). Every report exports to Excel (CSV) and PDF (browser print with print stylesheet).
- **Settings** — **ledger export** per entity: a checksummed JSON file of the entity's accounts, contacts, funds, projects and audit trail (`src/lib/export.ts`, `BackupRun` table). Runs nightly from `src/instrumentation.ts` at server boot, or on demand. A failed export returns HTTP 500, is written to the audit trail, and is shown in red; the green panel reads the last *successful* run, never the last run. Downloads are verified against the stored checksum before being served (409 on mismatch). The most recent 14 files per entity are kept; `BackupRun` rows are never deleted. `EXPORT_DIR` sets the location. Database-level backups are the database platform's job (Supabase daily backups / PITR). Append-only audit log (`AuditEvent` table, SHA-256 hash chain per entity with a per-entity `sequence` allocated under an advisory lock, no update/delete anywhere; `GET /api/audit` requires an `entityId` and returns 400 without one) recording every posting, edit, void, bank match, period filing and export with user and timestamp; chain verification badge.

## Key conventions (enforced)

- Money is integer **pesewas** everywhere; display divides by 100. Never floats for storage. In Postgres the money columns are `BigInt` (Postgres's `Int` is 32-bit and would cap a line at GHS 21.4M). **Every Prisma read goes through `src/lib/data/`**, which converts to JS `number` with `toMinor()`; generated Prisma types carrying `bigint` never leave that folder. A `bigint` that leaks fails as "Cannot mix BigInt and other types" far from its source, or as an unserialisable export — `assertNoBigInt` in `money.ts` names the offending path instead.
- The Ghana levy rule lives in `src/lib/ghana-tax.ts` and nowhere else. VAT, NHIL and GETFund are separately assessed and separately recoverable, so each is rounded independently rather than carved out of one 20% figure. The document form, the journal builder, the tax report and the tests all call it — there were once two implementations that disagreed, and invoices did not tie to the VAT return.
- Every record carries `entityId`; every query is entity-scoped. Adding a fourth entity must need no schema change. `Entity.id` **is** the slug the UI uses (`sprouted-roots`); `code` is the statutory short code (`SG001`). There is one identifier and no alias table.
- Contacts are shared across the group (the same supplier serves all three entities); scoping happens on `ContactEntityBalance` and, once persisted, `Document`.
- Double-entry only; nothing is hard-deleted — corrections are reversing entries.
- The UI says "money in / money out", never "debit / credit".
- `AuditEvent.metadataJson` is text, deliberately not `jsonb`: Postgres reorders jsonb keys and the stored bytes must be exactly the bytes that were hashed.
- Demo data lives in `src/lib/seed-data.ts` and nowhere else; the seed writes it, the shell currently reads it directly (until Phase 2 reads it back from the database). The demo ledger for reports is still `src/lib/report-data.ts`.
- Files that plain Node loads (the seed script and everything on its import path — `src/lib/data/chart.ts`, `enums.ts`, `seed-data.ts`, `account-templates.ts`) use `.ts` extensions on relative imports and never import `@/` at runtime. Node 24's native type stripping resolves relative imports strictly. `allowImportingTsExtensions` is on in `tsconfig.json` for this.

## Integrity tests

`npm test` runs the suites in `tests/`, none of which need a database:

- every journal balances, total money in = money out per entity, trial balance nets to zero, balance sheet balances (assets = liabilities + equity)
- every intercompany transaction is mirrored faithfully — both entities posted, each side balanced, and both sides moving the same amount. This is deliberately **not** a check that a pair nets to zero: an unreciprocated sale from A to B is normal and leaves A owed money.
- the Ghana levies stay in whole pesewas across bases chosen to round badly, and a journal built from them still balances exactly
- project-tagged lines reference known projects; project totals reconcile to their fund totals; seeded projects reference seeded funds
- the audit log is a chain: an edit, an edit-and-rehash, a deletion, a reorder, a renumbering and a sequence gap are each caught; truncation is documented as the one thing a chain alone cannot catch
- an export file is only trusted once re-read: checksum match, corruption, and a pruned/missing file are all detected; a `bigint` that bypassed the mappers is caught before serialisation
- negative cases (unbalanced journal, missing mirror, two sides disagreeing on the amount) are detected

## Known gaps / next steps

1. **Persistence** — invoices, bills, bank lines and reconciliation actions live in component state (with localStorage autosave); documents and journals are not yet written to the database. The schema has `Document`, `DocumentLine`, `TaxPeriodFiling` and `DocumentCounter` ready and migrated; nothing writes them yet. **Phase 2 of the current pass.**
2. **The UI still reads demo arrays**, not the database — `seedEntities`/`seedContacts` from `seed-data.ts`, and `ledgerLines`, `taxTransactions`, `intercompanyTransactions`, `bankDocuments`, `initialBankLines`, `metricsByEntity` from the shell and `report-data.ts`. Phase 2 moves entities, contacts, the chart and documents to the database; reports, tax, bank and intercompany follow in the next pass.
3. **Auth / users** — `currentUserName` in the shell is a placeholder. Once server functions land (Phase 2), every one of them is reachable by direct POST with no authentication. This is the first thing to do after this pass and before any real deployment.
4. **Bank reconciliation persistence** — matches, codings and imported lines should write journals and update document payment status. CSV import currently stores parsed **cedis** while everything else is pesewas (`parseAmount`).
5. **Intercompany** posts hardcoded `1010/4001` and `5001/2001`, ignores VAT, and ignores the chart's dedicated intercompany accounts (`1025–1027`, `2015–2017`).
6. **Navigation structure** — the single-shell `activeNav` pattern could be split into real routes once persistence exists. The `Inventory` item currently falls through to the bill editor by accident.
7. **GRA E-VAT** — placeholder fields only; add the integration later without redesigning.
8. **Deployment** — `render.yaml` targets Render's Node runtime with `prisma migrate deploy` in `preDeployCommand`. Not yet deployed. On the free plan the disk is ephemeral, so `EXPORT_DIR` needs a Render Disk for exports to persist across deploys.
9. **Prisma 7** changes the generator and adds a config file. Do not bump the major version casually.

## How to run

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass  # needed on this Windows machine
copy .env.example .env      # then fill in DATABASE_URL and DIRECT_URL
npm install                 # also runs `prisma generate`
npx prisma migrate deploy   # applies prisma/migrations to the database
npm run prisma:seed         # entities, charts, contacts, funds, projects — idempotent
npm run dev                 # http://localhost:3000
npm test
npm run lint
npm run build
```

`npx prisma migrate dev --name <change>` creates a new migration after a schema edit and re-runs the seed.

## Exports

Export files land in `EXPORT_DIR`, defaulting to `exports/` next to the app (git-ignored — an export contains the whole ledger and must never be committed). The Settings page shows the last successful export for the selected entity, flags a failed one in red, and offers verified downloads.

The scheduler is an in-process timer that runs one export per entity nightly. It suits a long-running server; on a host that sleeps idle services it runs when the service next wakes. It is a convenience copy — the database platform's own backups are the real safety net.
