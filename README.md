# Sprouted Group Accounting App

This is the new Next.js + TypeScript + Tailwind + Prisma project skeleton for the Sprouted Group accounting system.

## What this is right now

This is only the app shell and the data model foundation. It does not include business features yet.

The project is intentionally set up to follow the rules you gave:

- three entities only
- entity-scoped data by default
- double-entry accounting model
- money stored as integer pesewas
- Ghanaian VAT structure documented in the codebase
- user-facing language using "money in" and "money out"

## Run it locally

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Useful commands

```bash
npm run build
npm run start
npm run lint
```

## Folder guide

- app/ — the main Next.js app pages and layout
- src/app/ — the app router and the main UI shell
- src/lib/ — shared utilities, such as the Prisma client
- prisma/ — Prisma schema and database model definitions
- public/ — static files like images or icons
- .env — local environment variables
- .env.example — sample environment file for team members
- package.json — project scripts and dependency list

## Important note

This is intentionally a skeleton. The next steps are to add login, entities, chart of accounts, journal posting, and reporting, but not before the foundation is correct.
