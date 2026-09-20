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
- **Reports** — trial balance, profit & loss, balance sheet, cash flow, aged receivables, aged payables. All take a date range, are entity-scoped, include a prior-period comparison column, and every figure drills into the underlying ledger lines. Fund report (restricted/unrestricted, closing balance per fund) for Sprouted Roots only. **Project tracking** (Reports → Projects): each Sprouted Roots project (funder, restricted/unrestricted fund, budget) shows opening balance, funds received, expenses and closing balance per period with a budget-usage bar, all clickable to transactions; CSV export. Group view with all entities side by side plus a total column, clearly labelled as a management summary (not statutory consolidation, no eliminations). Every report exports to Excel (CSV) and PDF (browser print with print stylesheet).
- **Settings** — nightly automatic database backup (`VACUUM INTO`, SHA-256 checksum, `BackupRun` table) with download links and a manual "Run backup now". The scheduler starts at server boot from `src/instrumentation.ts`, not on first request — hung off a request handler it only ran if somebody opened the Backups page. A failed backup returns HTTP 500, is written to the audit trail, and is shown in red; the green panel reads the last *successful* run, never the last run. Downloads are verified against the stored checksum before being served (409 on mismatch). The most recent 14 backup files are kept; `BackupRun` rows are never deleted. Set `BACKUP_DIR` to put backups on separate durable storage — the default sits beside the database. Append-only audit log (`AuditEvent` table, SHA-256 hash chain per entity, no update/delete anywhere; `GET /api/audit` requires an `entityId` and returns 400 without one, rather than falling back to every entity) recording every posting, edit, void, bank match, period filing and backup with user and timestamp; chain verification badge.

## Key conventions (enforced)

- Money is integer **pesewas** everywhere; display divides by 100. Never floats for storage.
- The Ghana levy rule lives in `src/lib/ghana-tax.ts` and nowhere else. VAT, NHIL and GETFund are separately assessed and separately recoverable, so each is rounded independently rather than carved out of one 20% figure. The document form, the journal builder, the tax report and the tests all call it — there were once two implementations that disagreed, and invoices did not tie to the VAT return.
- Every record carries `entityId`; every query is entity-scoped. Adding a fourth entity must need no schema change.
- Double-entry only; nothing is hard-deleted — corrections are reversing entries.
- The UI says "money in / money out", never "debit / credit".
- The demo ledger (`src/lib/report-data.ts`) and the tax rule (`src/lib/ghana-tax.ts`) are shared between the shell and the tests, so the figures under test are the figures users see. Note `src/lib/accounting-integrity.ts` is exercised by the tests only — the shell does not import it.

## Integrity tests

`npm test` runs the suites in `tests/`, proving:

- every journal balances, total money in = money out per entity, trial balance nets to zero, balance sheet balances (assets = liabilities + equity)
- every intercompany transaction is mirrored faithfully — both entities posted, each side balanced, and both sides moving the same amount. This is deliberately **not** a check that a pair nets to zero: an unreciprocated sale from A to B is normal and leaves A owed money. (It previously read `net % 1 === 0`, which is true of every integer and so proved nothing.)
- the Ghana levies stay in whole pesewas across bases chosen to round badly, and a journal built from them still balances exactly
- project-tagged lines reference known projects, and project totals reconcile to their fund totals
- a backup file is only trusted once re-read: checksum match, corruption, and a pruned/missing file are all detected
- negative cases (unbalanced journal, missing mirror, two sides disagreeing on the amount) are detected

## Known gaps / next steps

1. **Persistence** — invoices, bills, bank lines and reconciliation actions currently live in component state (with localStorage autosave); documents and journals are not yet written to Prisma tables. The schema has Entity, Account, JournalEntry, JournalLine, Contact, ContactEntityBalance, AuditEvent, BackupRun — documents need a Document/DocumentLine model (or equivalent) added.
2. **Entity id aliasing** — the UI uses stable ids (`sprouted-roots`, `sprouted-crafts`, `oikazi`) while seeded DB rows use CUIDs; the audit API currently resolves aliases by name. When persistence lands, unify these (prefer stable slugs as primary keys).
3. **Auth / users** — `currentUserName` in the shell is a placeholder ('Edem Agblevor'); wire to real authentication so the audit log records the true user.
4. **Bank reconciliation persistence** — matches, codings and imported lines should write journals and update document payment status.
5. **Navigation structure** — the single-shell `activeNav` pattern could be split into real routes (`/sales`, `/reports`, etc.) once persistence exists.
6. **GRA E-VAT** — placeholder fields only; add the integration later without redesigning.
7. **No deploy configuration** — the pre-rebuild Flask app and its Render config were removed in `38ed586`. Nothing has replaced them, so there is currently no way to deploy this app. Write the new config together with the datasource decision in gap 9, since the build command, persistent-disk needs and `BACKUP_DIR` all follow from it. Note the old `supabase_schema.sql` (in history, not the tree) modelled `companies`/`users`/`transactions` with `amount numeric` — no double-entry, no entity scoping, money as a float — so do not resurrect it as the basis for a Postgres migration.
8. **Unit price is entered in pesewas but reads as a price** — the Sales/Purchases line input stores pesewas (everything renders through `Money`, which divides by 100) while the field shows `step="0.01"`. Typing `250` books GHS 2.50. Either accept cedis and convert on entry, or relabel the field.
9. **Deployment / durability** — SQLite on an ephemeral host loses the database itself on every redeploy, not just the backups. Supabase credentials already exist in `.env`; moving the datasource to Postgres would settle durability, backups and the mock-data gap together.

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

Backup files land in `BACKUP_DIR`, defaulting to the `backups/` folder (git-ignored — a backup contains the whole ledger and must never be committed). The Settings page shows the last successful run, flags a failed one in red, and offers verified downloads.

`DATABASE_URL` is resolved the way Prisma resolves it: a relative `file:` URL is relative to the **schema directory** (`prisma/`), not the working directory. So `file:./dev.db` means `prisma/dev.db`.

The scheduler is an in-process timer, which suits a long-running server. On a host with ephemeral or per-request processes it will not fire reliably — there, drive backups from an external scheduler that POSTs to `/api/backups`.
