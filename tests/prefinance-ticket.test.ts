/**
 * Reading a weighbridge ticket.
 *
 * Every refusal here is a mistake that actually happens at a gate. Catching
 * one costs a second; settling against it and finding out at the end of the
 * season costs a great deal more.
 */

import { describe, expect, it } from 'vitest';

import { netWeight, validateTicket } from '@/lib/prefinance';

describe('the weight to settle on', () => {
  it('is gross less tare when the truck was weighed twice', () => {
    expect(netWeight({ grossGrams: 12_000_000, tareGrams: 9_000_000 })).toBe(3_000_000);
  });

  it('is the net on its own when there was no weighbridge', () => {
    expect(netWeight({ netGrams: 3_000_000 })).toBe(3_000_000);
  });

  // The ticket is the record. A typed net that disagrees with the two weights
  // is a typo, not a second opinion.
  it('prefers the two weighbridge weights over a typed net that disagrees', () => {
    expect(netWeight({ grossGrams: 12_000_000, tareGrams: 9_000_000, netGrams: 4_000_000 })).toBe(3_000_000);
  });

  it('is nothing at all when neither was given', () => {
    expect(netWeight({})).toBeNull();
    expect(netWeight({ bags: 40 })).toBeNull();
  });
});

describe('what is wrong with a ticket', () => {
  it('accepts an ordinary one', () => {
    expect(validateTicket({ grossGrams: 12_000_000, tareGrams: 9_000_000, bags: 37 })).toEqual([]);
  });

  it('catches the two weights entered the wrong way round', () => {
    const problems = validateTicket({ grossGrams: 9_000_000, tareGrams: 12_000_000 });
    expect(problems.join(' ')).toContain('wrong way round');
  });

  it('catches an empty truck that weighs the same as a loaded one', () => {
    expect(validateTicket({ grossGrams: 9_000_000, tareGrams: 9_000_000 })).not.toEqual([]);
  });

  it('asks for the second weight when only one was given', () => {
    expect(validateTicket({ grossGrams: 12_000_000 }).join(' ')).toContain('both weights');
    expect(validateTicket({ tareGrams: 9_000_000 }).join(' ')).toContain('both weights');
  });

  it('asks for something when nothing was given', () => {
    expect(validateTicket({}).join(' ')).toContain('net weight');
  });

  it('catches a bag count that cannot be true for the weight', () => {
    // 3,000kg across 10 bags is 300kg a bag. A bag is 80kg.
    expect(validateTicket({ netGrams: 3_000_000, bags: 10 }).join(' ')).toContain('a bag');
    // And the other way: 3,000kg across 200 bags is 15kg a bag.
    expect(validateTicket({ netGrams: 3_000_000, bags: 200 }).join(' ')).toContain('a bag');
  });

  it('allows the ordinary spread around 80kg without complaining', () => {
    for (const bags of [34, 37, 40, 45]) {
      expect(validateTicket({ netGrams: 3_000_000, bags })).toEqual([]);
    }
  });

  it('takes a different bag size when a commodity uses one', () => {
    // At a 64kg bag, 47 bags for 3,000kg is ordinary.
    expect(validateTicket({ netGrams: 3_000_000, bags: 47 }, 64_000)).toEqual([]);
  });

  it('says nothing about bags when none were counted', () => {
    expect(validateTicket({ netGrams: 3_000_000 })).toEqual([]);
  });
});
