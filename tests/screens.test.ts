/**
 * Each screen is sent only the sections src/lib/screens.ts names for it. A
 * screen that reads a section not on its list would show that section empty —
 * no error, just nothing there. This reads the shell's source, finds every
 * section field each screen's branch reads (directly, or through a value
 * derived from one at the top of the component), and checks the list covers it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { screens, sections, sectionsByScreen, screenOf, type Screen, type Section } from '@/lib/screens';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
const { sectionFields } = await import('@/lib/data/documents');

const source = readFileSync(new URL('../src/components/app/app-shell.tsx', import.meta.url), 'utf8');
const lines = source.split('\n');

const sectionOfField = new Map<string, Section>();
for (const section of sections) for (const field of sectionFields[section]) sectionOfField.set(field, section);

const fieldsIn = (text: string) => new Set([...text.matchAll(/initialData\.(\w+)/g)].map((m) => m[1]));

// Values computed at the top of the component from initialData, and which fields each one reads.
const declarationStart = /^ {2}(const|let|function|return|useEffect|type|\/\/|\/\*\*)\b/;
const derived = new Map<string, Set<string>>();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^ {2}const (\w+)\b/);
  if (!m) continue;
  let end = i + 1;
  while (end < lines.length && !declarationStart.test(lines[end])) end++;
  derived.set(m[1], fieldsIn(lines.slice(i, end).join('\n')));
}
// Follow one derived value through another until nothing changes.
for (let changed = true; changed; ) {
  changed = false;
  for (const [name, fields] of derived) {
    for (const [other, otherFields] of derived) {
      if (other === name || !new RegExp(`\\b${other}\\b`).test(lines.find((l) => l.startsWith(`  const ${name}`)) ?? '')) continue;
      for (const field of otherFields) if (!fields.has(field)) { fields.add(field); changed = true; }
    }
  }
}

// The screen branches: the outermost `activeNav === ...` chain, at ten spaces.
const start = lines.findIndex((l) => /^ {10}\{activeNav === 'Dashboard' \? \($/.test(l));
const end = lines.findIndex((l, i) => i > start && /^ {10}\)\}$/.test(l));
const separators = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i >= start && i < end && (/^ {10}\) : /.test(l) || i === start));
const branches: { screens: Screen[]; text: string }[] = separators.map(({ l, i }, n) => {
  const named = l.match(/activeNav === '([^']+)'/)?.[1] as Screen | undefined;
  return { screens: named ? [named] : ['Sales', 'Purchases'], text: lines.slice(i, separators[n + 1]?.i ?? end).join('\n') };
});

function sectionsRead(text: string): Set<Section> {
  const fields = fieldsIn(text);
  for (const [name, derivedFields] of derived) if (new RegExp(`\\b${name}\\b`).test(text)) for (const f of derivedFields) fields.add(f);
  return new Set([...fields].flatMap((f) => (sectionOfField.has(f) ? [sectionOfField.get(f)!] : [])));
}

describe('screens and the sections they are sent', () => {
  it('finds a branch for every screen', () => {
    expect(start).toBeGreaterThan(0);
    const covered = new Set(branches.flatMap((b) => b.screens));
    for (const screen of screens) expect(covered, screen).toContain(screen);
  });

  it('sends every screen each section its branch reads', () => {
    const missing: string[] = [];
    for (const branch of branches) {
      for (const section of sectionsRead(branch.text)) {
        for (const screen of branch.screens) if (!sectionsByScreen[screen].includes(section)) missing.push(`${screen} reads ${section}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('reads no section outside the screen branches, where any screen could be showing', () => {
    const outside = [...lines.slice(0, start), ...lines.slice(end)].filter((l) => !/^ {2}const \w+/.test(l)).join('\n');
    // Derived values are checked through the branches that use them; anything else must be shared data.
    const direct = [...fieldsIn(outside)].filter((f) => sectionOfField.has(f) && ![...derived.values()].some((fields) => fields.has(f)));
    expect(direct).toEqual([]);
  });

  it('turns anything unknown in the address into the dashboard', () => {
    expect(screenOf('Payroll')).toBe('Payroll');
    expect(screenOf('Cash flow')).toBe('Cash flow');
    expect(screenOf('payroll')).toBe('Dashboard');
    expect(screenOf(undefined)).toBe('Dashboard');
    expect(screenOf(['Payroll', 'Tax'])).toBe('Dashboard');
  });
});
