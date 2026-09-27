/**
 * Which migrations can safely run against a database that a live deployment is
 * reading, and which cannot.
 *
 * This exists because of one afternoon. A migration run from a laptop dropped
 * a column the deployed code still selected, and every page of the live site
 * returned a server error until the deploy caught up. The lesson was not "never
 * migrate production" — the deploy itself has to — but that *adding* is
 * invisible to code already running, and *removing or changing* is not.
 *
 * So:
 *
 *  - **Additive** — a new table, a new index, a new type, a new nullable or
 *    defaulted column, a new constraint. Code that has never heard of any of
 *    them carries on unaffected.
 *  - **Everything else** — dropping, renaming, retyping, making a column NOT
 *    NULL, or touching data. Older code can see the difference, and usually
 *    stops working.
 *
 * Anything this cannot confidently recognise is treated as unsafe. A guard
 * that guesses in the permissive direction is not a guard.
 *
 * Pure: no I/O, no database.
 */

export type StatementVerdict = {
  statement: string;
  safe: boolean;
  /** Why, in words a person reading a refusal can act on. */
  reason: string;
};

export type MigrationVerdict = {
  additive: boolean;
  statements: StatementVerdict[];
  /** Just the unsafe ones, for the message. */
  blocking: StatementVerdict[];
};

/** Strip comments and split into statements. */
export function statementsIn(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);
}

/**
 * The columns an ALTER TABLE adds, one fragment each, so a statement adding a
 * safe column and an unsafe one in the same breath is judged on both.
 */
function addedColumns(statement: string): string[] {
  const parts = statement.split(/\bADD COLUMN\b/i).slice(1);
  return parts.map((part) => {
    // Up to the next clause of the same statement.
    const cut = part.search(/\bADD (CONSTRAINT|COLUMN)\b|\bALTER COLUMN\b|\bDROP\b/i);
    return (cut >= 0 ? part.slice(0, cut) : part).trim().replace(/,\s*$/, '');
  });
}

const looksNotNull = (fragment: string): boolean => /\bNOT NULL\b/i.test(fragment);
const hasDefault = (fragment: string): boolean => /\bDEFAULT\b/i.test(fragment);

export function classifyStatement(statement: string): StatementVerdict {
  const upper = statement.toUpperCase();
  const safe = (reason: string): StatementVerdict => ({ statement, safe: true, reason });
  const unsafe = (reason: string): StatementVerdict => ({ statement, safe: false, reason });

  // Plainly destructive, whatever else is in the statement.
  if (/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|INDEX|CONSTRAINT|DEFAULT|NOT NULL)\b/i.test(statement)) {
    return unsafe('drops something the running code may still be using');
  }
  if (/\bRENAME\b/i.test(statement)) {
    return unsafe('renames something, which older code will look for under its old name');
  }
  if (/\bALTER\s+COLUMN\b/i.test(statement)) {
    return unsafe('changes an existing column, which can reclassify or reject data the running code writes');
  }
  if (/^(TRUNCATE|DELETE|UPDATE|INSERT)\b/i.test(upper)) {
    return unsafe('changes data rather than only structure');
  }

  if (/^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|TYPE|SCHEMA|EXTENSION|SEQUENCE)\b/i.test(upper)) {
    return safe('adds something new, which code that has never heard of it ignores');
  }

  if (/^ALTER\s+TABLE\b/i.test(upper)) {
    const columns = addedColumns(statement);
    if (columns.length > 0) {
      const bad = columns.find((fragment) => looksNotNull(fragment) && !hasDefault(fragment));
      if (bad) {
        return unsafe(`adds a NOT NULL column with no default (${bad.split(/\s+/)[0]}), which every existing row and every insert from the running code would fail`);
      }
      return safe('adds columns that are nullable or defaulted, so existing rows and older inserts are unaffected');
    }
    if (/\bADD\s+CONSTRAINT\b/i.test(statement)) {
      return safe('adds a constraint; it either holds for the data already there or the migration stops');
    }
    return unsafe('alters a table in a way this guard does not recognise');
  }

  return unsafe('is a kind of statement this guard does not recognise, so it is not assumed safe');
}

/**
 * Whether a whole migration can run under a live deployment. Additive only if
 * every statement in it is.
 */
export function classifyMigration(sql: string): MigrationVerdict {
  const statements = statementsIn(sql).map(classifyStatement);
  const blocking = statements.filter((verdict) => !verdict.safe);
  return { additive: blocking.length === 0 && statements.length > 0, statements, blocking };
}

/** The same, over several pending migrations at once. */
export function classifyMigrations(files: readonly { name: string; sql: string }[]): {
  additive: boolean;
  byMigration: { name: string; verdict: MigrationVerdict }[];
} {
  const byMigration = files.map((file) => ({ name: file.name, verdict: classifyMigration(file.sql) }));
  return { additive: byMigration.every((row) => row.verdict.additive), byMigration };
}
