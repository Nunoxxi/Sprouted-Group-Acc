/**
 * Telling a migration that can run under a live site from one that cannot.
 *
 * The case that matters most is the first one: the statement that actually
 * took the site down.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyMigration, classifyMigrations, classifyStatement, statementsIn } from '@/lib/migration-safety';

describe('the statement that took the site down', () => {
  it('is refused', () => {
    const verdict = classifyStatement('ALTER TABLE "Contact" DROP COLUMN "isFarmerAggregator"');
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('drops something');
  });
});

describe('what may run under a live deployment', () => {
  const safe = [
    'CREATE TABLE "LoanFacility" ("id" TEXT NOT NULL, CONSTRAINT "LoanFacility_pkey" PRIMARY KEY ("id"))',
    'CREATE INDEX "Advance_entityId_idx" ON "Advance"("entityId")',
    'CREATE UNIQUE INDEX "Cycle_entityId_reference_key" ON "Cycle"("entityId", "reference")',
    'CREATE TYPE "AdvanceStatus" AS ENUM (\'OPEN\', \'SETTLED\')',
    'ALTER TABLE "Advance" ADD CONSTRAINT "Advance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    'ALTER TABLE "Contact" ADD COLUMN "exposureLimitMinor" BIGINT',
    'ALTER TABLE "Contact" ADD COLUMN "exposureLimitMinor" BIGINT NOT NULL DEFAULT 0',
  ];

  for (const statement of safe) {
    it(`allows: ${statement.slice(0, 54)}…`, () => {
      expect(classifyStatement(statement).safe).toBe(true);
    });
  }

  const unsafe: [string, string][] = [
    ['ALTER TABLE "Contact" DROP COLUMN "tin"', 'drops'],
    ['DROP TABLE "Cycle"', 'drops'],
    ['ALTER TABLE "Contact" RENAME COLUMN "tin" TO "taxId"', 'renames'],
    ['ALTER TABLE "Project" ALTER COLUMN "budgetMinor" SET NOT NULL', 'changes an existing column'],
    ['ALTER TABLE "Project" ALTER COLUMN "code" TYPE VARCHAR(10)', 'changes an existing column'],
    ['UPDATE "Contact" SET "tin" = NULL', 'changes data'],
    ['DELETE FROM "Cycle"', 'changes data'],
    ['TRUNCATE "Cycle"', 'changes data'],
    ['ALTER TABLE "Contact" ADD COLUMN "mustHave" TEXT NOT NULL', 'NOT NULL column with no default'],
    ['GRANT ALL ON SCHEMA public TO postgres', 'does not recognise'],
  ];

  for (const [statement, reason] of unsafe) {
    it(`refuses: ${statement.slice(0, 54)}…`, () => {
      const verdict = classifyStatement(statement);
      expect(verdict.safe).toBe(false);
      expect(verdict.reason).toContain(reason);
    });
  }
});

describe('a statement that adds a safe column and an unsafe one together', () => {
  it('is judged on the unsafe one, not the first one it sees', () => {
    const verdict = classifyStatement(
      'ALTER TABLE "Project" ADD COLUMN "closedAt" TIMESTAMP(3), ADD COLUMN "kind" TEXT NOT NULL',
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('kind');
  });

  it('and allows it when every column is defaulted', () => {
    const verdict = classifyStatement(
      'ALTER TABLE "Project" ADD COLUMN "closedAt" TIMESTAMP(3), ADD COLUMN "kind" TEXT NOT NULL DEFAULT \'GRANT_FUNDED\'',
    );
    expect(verdict.safe).toBe(true);
  });
});

describe('reading a migration file', () => {
  it('ignores comments and blank lines', () => {
    const sql = `-- CreateTable\n-- a note\n\nCREATE TABLE "X" ("id" TEXT NOT NULL);\n\n-- CreateIndex\nCREATE INDEX "X_id" ON "X"("id");\n`;
    expect(statementsIn(sql)).toHaveLength(2);
    expect(classifyMigration(sql).additive).toBe(true);
  });

  it('a migration is additive only if every statement in it is', () => {
    const sql = 'CREATE TABLE "X" ("id" TEXT NOT NULL);\nALTER TABLE "Contact" DROP COLUMN "tin";';
    const verdict = classifyMigration(sql);
    expect(verdict.additive).toBe(false);
    expect(verdict.blocking).toHaveLength(1);
  });

  it('an empty migration is not called additive, because there is nothing to judge', () => {
    expect(classifyMigration('-- nothing here\n').additive).toBe(false);
  });

  it('several pending migrations are additive only if all of them are', () => {
    const result = classifyMigrations([
      { name: 'a', sql: 'CREATE TABLE "X" ("id" TEXT NOT NULL);' },
      { name: 'b', sql: 'ALTER TABLE "Y" DROP COLUMN "z";' },
    ]);
    expect(result.additive).toBe(false);
    expect(result.byMigration.find((row) => row.name === 'a')?.verdict.additive).toBe(true);
  });
});

describe('against the migrations this repository actually has', () => {
  const dir = join(process.cwd(), 'prisma', 'migrations');
  const names = readdirSync(dir).filter((name) => !name.endsWith('.toml'));

  it('reads every one of them without choking', () => {
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      expect(() => classifyMigration(sql)).not.toThrow();
    }
  });

  it('names the ones that would not be allowed under a live site', () => {
    const risky = names.filter((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      return !classifyMigration(sql).additive;
    });
    // The column drop is one of them; that is the point of the whole file.
    expect(risky).toContain('20260923110000_drop_farmer_aggregator_flag');
  });

  it('and allows the plainly additive ones', () => {
    const sql = readFileSync(join(dir, '20260923050000_data_protection', 'migration.sql'), 'utf8');
    expect(classifyMigration(sql).additive).toBe(true);
  });
});
