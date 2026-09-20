# Sprouted Group Accounting App Brief

The app serves Sprouted Group, three Ghanaian companies: Sprouted Roots (farmer programs and raw material aggregation), Sprouted Crafts (cashew processing) and Oikazi (cocoa processing). They trade with each other constantly.

Non-negotiable rules for all code:

- Every record carries an entityId. Every database query is scoped by entity by default. Adding a fourth entity must require no schema change.
- Accounting is double-entry. Every transaction posts balanced debits and credits to a journal. Nothing is ever hard-deleted — corrections are reversing entries.
- Money is stored as integers in pesewas, never as floating-point numbers. Currency is Ghana cedi (GHS).
- Ghana VAT is 20% effective, made up of 15% VAT, 2.5% NHIL and 2.5% GETFund, all charged on the same base and all recoverable as input tax.
- Users are not accountants. The interface says "money in" and "money out", never "debit" and "credit".

The build must be a multi-entity accounting web app for Sprouted Group.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
