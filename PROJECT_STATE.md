# Sprouted Group — Project State

Read [CLAUDE.md](CLAUDE.md) first — it contains the non-negotiable accounting rules. This file describes where the project stands right now, for any developer or AI picking it up.

## Stack

- Next.js 16.3.5 (App Router) + React 19 + TypeScript
- Tailwind CSS 3.4 (Xero-inspired warm neutral design system in `src/app/globals.css` and `src/components/ui/`)
- Prisma 6 + SQLite (`prisma/schema.prisma`, dev database at `prisma/dev.db` via `DATABASE_URL` in `.env`)
- Vitest for integrity tests (`npm test`)

## What is built

All current UI lives in `src/components/app/app-shell.tsx` (single shell, sidebar navigation). Each module:

- **Dashboard** — cash position, money owed to us, money we owe, intercompany balance; shared contacts with per-entity balances; entity switcher; add-entity form
- **Sales / Purchases** — Xero-style invoice and bill editor. Line items with description, quantity, unit price, account code, VAT treatment (standard / zero-rated / exempt). Ghana VAT split: 15% VAT + 2.5% NHIL + 2.5% GETFund on the same base, shown separately. Bills withhold WHT (5%/10%) based on the supplier's status and show net payable. Status flow: draft → awaiting payment → paid, plus voided. Every document generates a balanced journal (collapsible panel). Autosaves to localStorage. E-VAT placeholder fields (clearance number, QR code, timestamp) exist on invoices — no GRA integration yet.
- **Bank** — CSV import with first-import column mapping saved per bank; two-column reconciliation (bank lines left, suggested matches right) with confidence scores from amount/date/contact; keyboard operated (arrows + Enter); in-row account coding; bulk match for repeated identical transactions; undo match; unreconciled counter.
- **Intercompany** — one entry posts both sides: sales invoice on the source entity and mirrored purchase bill on the target, linked by a shared reference. Group balance matrix across all entities (scales past three) with mismatch highlighting. Related-party report with both journal entries side by side.
- **Tax** — per-entity VAT return per period (output VAT, input VAT, NHIL, GETFund, net position), every figure clickable to drill into transactions. Filing a period locks it — documents dated in a filed period cannot change status; corrections must be reversing adjustments in the current period. WHT report per supplier with TIN and CSV export for GRA.
- **Reports** — trial balance, profit & loss, balance sheet, cash flow, aged receivables, aged payables. All take a date range, are entity-scoped, include a prior-period comparison column, and every figure drills into the underlying ledger lines. Fund report (restricted/unrestricted, closing balance per fund) for Sprouted Roots only. Group view with all entities side by side plus a total column, clearly labelled as a management summary (not statutory consolidation, no eliminations). Every report exports to Excel (CSV) and PDF (browser print with print stylesheet).
- **Settings** — nightly automatic database backup (`VACUUM INTO`, SHA-256 checksum, `BackupRun` table) with download links and a manual "Run backup now"; starts on first request to `/api/backups`. Append-only audit log (`AuditEvent` table, SHA-256 hash chain per entity, no update/delete anywhere) recording every posting, edit, void, bank match, period filing and backup with user and timestamp; chain verification badge.

## Key conventions (enforced)

- Money is integer **pesewas** everywhere; display divides by 100. Never floats for storage.
- Every record carries `entityId`; every query is entity-scoped. Adding a fourth entity must need no schema change.
- Double-entry only; nothing is hard-deleted — corrections are reversing entries.
- The UI says "money in / money out", never "debit / credit".
- The demo ledger (`src/lib/report-data.ts`) and report helpers are shared between the shell and the integrity tests, so tests prove what users see.

## Integrity tests

`npm test` runs `tests/accounting-integrity.test.ts`, proving: every journal balances, total debits = credits per entity, trial balance nets to zero, balance sheet balances (assets = liabilities + equity), intercompany pairs net to zero, and negative cases (unbalanced journal, missing mirror) are detected.

## Known gaps / next steps

1. **Persistence** — invoices, bills, bank lines and reconciliation actions currently live in component state (with localStorage autosave); documents and journals are not yet written to Prisma tables. The schema has Entity, Account, JournalEntry, JournalLine, Contact, ContactEntityBalance, AuditEvent, BackupRun — documents need a Document/DocumentLine model (or equivalent) added.
2. **Entity id aliasing** — the UI uses stable ids (`sprouted-roots`, `sprouted-crafts`, `oikazi`) while seeded DB rows use CUIDs; the audit API currently resolves aliases by name. When persistence lands, unify these (prefer stable slugs as primary keys).
3. **Auth / users** — `currentUserName` in the shell is a placeholder ('Edem Agblevor'); wire to real authentication so the audit log records the true user.
4. **Bank reconciliation persistence** — matches, codings and imported lines should write journals and update document payment status.
5. **Navigation structure** — the single-shell `activeNav` pattern could be split into real routes (`/sales`, `/reports`, etc.) once persistence exists.
6. **GRA E-VAT** — placeholder fields only; add the integration later without redesigning.

## How to run

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass  # needed on this Windows machine
npm install
npx prisma db push --schema prisma/schema.prisma
node scripts/seed-accounts.mjs
npm run dev   # http://localhost:3000
npm test      # accounting integrity tests
npm run build # production build
```

## Backups

Backup files land in the `backups/` folder (git-ignored). The Settings page shows the last run and offers downloads.
