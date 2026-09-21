'use server';

/**
 * Server Functions for invoices and bills.
 *
 * Every function takes an explicit entityId, verifies it, and scopes every
 * query by it. Changes that matter are made inside one transaction together
 * with their audit event, so the ledger can never hold a journal without the
 * event that explains it, or the reverse.
 *
 * Every function is reachable by direct POST, so none of them trusts the
 * caller: the first thing each does is ask src/lib/dal.ts who is signed in
 * and whether their role and entity access allow the operation. The
 * identity recorded on journals, documents, filings and audit events is the
 * session's, never an argument.
 *
 * Server functions dispatch sequentially on the client, so a debounced
 * autosave queued behind a slow post blocks other actions — the shell
 * cancels its autosave timer before posting or voiding.
 */

import { refresh } from 'next/cache';

import { journalEntriesBalance } from '@/lib/accounting-integrity';
import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess, requirePermission } from '@/lib/dal';
import { ensureDefaultBankAccount, seedChartForEntity } from '@/lib/data/chart.ts';
import { documentInclude, documentRecord, kindToPrisma, saleTypeToPrisma, vatToPrisma } from '@/lib/data/documents';
import { contactRecord, entityRecord, rateText, toPrismaEnum } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import { moveBalance, StockRefusal } from '@/lib/data/stock';
import { unitToRecord } from '@/lib/data/inventory';
import { landedToPrisma } from '@/lib/data/trading';
import { allocateByWeight } from '@/lib/trading';
import { allocateReceiptValues, formatKg, toGrams } from '@/lib/inventory';
import { roundPesewas } from '@/lib/ghana-tax';
import type { ContactRecord, DocumentRecord, EntityRecord, EntityType } from '@/lib/data/types';
import {
  accountNameMap,
  buildTotals,
  controlAccounts,
  documentTaxFor,
  journalLinesFor,
  normalizeDocument,
  periodOf,
  type DocumentFormState,
} from '@/lib/documents';
import { convertJournal, normalizeRate, selectRate, settlementFor, type Currency, type FxJournalLine } from '@/lib/fx';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { accentPalette } from '@/lib/seed-data';

import type { WithholdingTaxStatus } from '@/lib/ghana-tax';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

/**
 * Authorize first, then run. Nothing inside `run` executes — no query, no
 * read — unless the signed-in user may perform `permission` on `entityId`.
 * An authorization failure is returned as a value, like any other refusal.
 */
async function withEntityAccess<T>(
  entityId: string,
  permission: Permission,
  run: (principal: Principal) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

async function withPermission<T>(permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requirePermission(permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

async function requireEntity(entityId: string) {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { id: true, name: true, functionalCurrency: true, vatRegistered: true, vatRegisteredFrom: true },
  });
  if (!entity) {
    throw new Error(`Unknown entity ${entityId}`);
  }
  return {
    ...entity,
    vatRegisteredFrom: entity.vatRegisteredFrom ? entity.vatRegisteredFrom.toISOString().slice(0, 10) : null,
  };
}

function dateOf(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date ${value}`);
  }
  return date;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function decimalOf(rate: string): Prisma.Decimal {
  return new Prisma.Decimal(normalizeRate(rate));
}

/** The stored shape of a converted journal line: both currencies, the rate, the direction. */
function lineData(entityId: string, line: FxJournalLine, accountId: string, contactId: string | null) {
  return {
    entityId,
    accountId,
    contactId,
    txnCurrency: line.currency,
    txnAmountMinor: fromMinor(line.txnAmount),
    rate: decimalOf(line.rate),
    amountMinor: fromMinor(line.functionalAmount),
    direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const),
  };
}

/** The rate a draft will post at: its saved rate, else the table's default for its date. */
async function rateForDraft(entityId: string, form: DocumentFormState, functionalCurrency: Currency) {
  if (form.currency === functionalCurrency) {
    return { rate: '1.0', rateDate: form.date, rateExact: true };
  }
  if (form.rate) {
    try {
      return { rate: normalizeRate(form.rate), rateDate: form.rateDate ?? form.date, rateExact: form.rateExact };
    } catch {
      return null;
    }
  }
  const rows = await prisma.exchangeRate.findMany({ where: { entityId }, select: { base: true, quote: true, date: true, rate: true } });
  const quote = selectRate(
    rows.map((row) => ({ base: row.base, quote: row.quote, date: row.date.toISOString().slice(0, 10), rate: rateText(row.rate) ?? '1.0' })),
    form.currency,
    functionalCurrency,
    form.date,
  );
  return quote ? { rate: quote.rate, rateDate: quote.rateDate, rateExact: quote.exact && !quote.inverted } : null;
}

function documentLabel(kind: 'invoice' | 'bill', number: string): string {
  return `${kind === 'invoice' ? 'Invoice' : 'Bill'} ${number || '(draft)'}`;
}

/** A document past DRAFT always has a number; one without is corrupt, not a draft. */
function postedNumberOf(document: { id: string; status: string; number: string | null }): string {
  if (document.status === 'DRAFT' || !document.number) {
    throw new Error(`Document ${document.id} has status ${document.status} but no number`);
  }
  return document.number;
}

// --- drafts ------------------------------------------------------------------------

/**
 * Create or update a draft. Silently does nothing if the document is no
 * longer a draft — the editor's autosave can fire after a post, and that
 * must not be an error.
 */
export async function saveDocumentDraft(entityId: string, input: unknown): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:draft', (principal) => saveDraft(entityId, input, principal));
}

async function saveDraft(entityId: string, input: unknown, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  const entity = await requireEntity(entityId);

  const kind = (input as { kind?: string } | null)?.kind === 'bill' ? 'bill' : 'invoice';
  const fallbackContact = await prisma.contact.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { name: 'asc' } });
  const form = normalizeDocument(input, kind, fallbackContact?.id ?? '');

  if (!form.contactId) {
    return fail('Choose a contact before saving.');
  }
  if (form.rate !== null) {
    try {
      normalizeRate(form.rate);
    } catch {
      return fail('The exchange rate must be a positive decimal number.');
    }
  }
  const rateFields =
    form.currency === entity.functionalCurrency
      ? { currency: form.currency, rate: decimalOf('1.0'), rateDate: dateOf(form.date), rateExact: true }
      : { currency: form.currency, rate: form.rate ? decimalOf(form.rate) : null, rateDate: form.rateDate ? dateOf(form.rateDate) : null, rateExact: form.rateExact };

  const accounts = await prisma.account.findMany({ where: { entityId, isActive: true }, select: { id: true, code: true } });
  const accountIdOf = new Map(accounts.map((account) => [account.code, account.id]));
  for (const line of form.lines) {
    if (!accountIdOf.has(line.accountCode)) {
      return fail(`Account ${line.accountCode} is not in this entity's chart.`);
    }
  }

  const contact = await prisma.contact.findUnique({ where: { id: form.contactId }, select: { id: true } });
  if (!contact) {
    return fail('That contact no longer exists.');
  }

  // Sale type is an invoice thing and import VAT a bill thing; normalizeDocument
  // has already zeroed whichever does not apply to this kind.
  const vatFields = {
    saleType: saleTypeToPrisma[form.saleType],
    importVatMinor: fromMinor(form.importVat),
    // Recorded for the draft's date now, fixed at posting.
    vatApplied: documentTaxFor(entity, form.date).vatApplies,
  };

  // A bill line that receives stock names an item of this entity and a
  // location of this entity, and is posted to the account the item is
  // carried in — so the receipt and the ledger cannot disagree.
  const itemIds = form.lines.flatMap((line) => (line.itemId ? [line.itemId] : []));
  const items = itemIds.length ? await prisma.item.findMany({ where: { id: { in: itemIds }, entityId, isActive: true }, include: { account: { select: { code: true } } } }) : [];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const locationIds = form.lines.flatMap((line) => (line.locationId ? [line.locationId] : []));
  const locations = locationIds.length ? await prisma.stockLocation.findMany({ where: { id: { in: locationIds }, entityId, isActive: true }, select: { id: true } }) : [];
  const locationIdSet = new Set(locations.map((location) => location.id));
  for (const line of form.lines) {
    if (!line.itemId) continue;
    const item = itemById.get(line.itemId);
    if (!item) return fail('A line names a stock item that does not belong to this entity.');
    if (item.account.code !== line.accountCode) return fail(`${item.code} is carried in ${item.account.code}; post the line there.`);
    if (!line.locationId || !locationIdSet.has(line.locationId)) return fail(`Choose where ${item.code} is received.`);
    if (!(line.quantity > 0)) return fail(`Enter the quantity of ${item.code} received.`);
    if (line.landedCostKind) return fail('A line either receives stock or is a landed cost, not both.');
  }
  // A landed-cost line is spread over lots of this entity and posts to the
  // account those lots are carried in, so the charge lands in stock value.
  const landedLotIds = [...new Set(form.lines.flatMap((line) => (line.landedCostKind ? line.landedCostLotIds : [])))];
  const landedLots = landedLotIds.length ? await prisma.lot.findMany({ where: { id: { in: landedLotIds }, entityId }, include: { item: { include: { account: { select: { code: true } } } }, location: { include: { account: { select: { code: true } } } } } }) : [];
  const lotById = new Map(landedLots.map((lot) => [lot.id, lot]));
  for (const line of form.lines) {
    if (!line.landedCostKind) continue;
    if (line.landedCostLotIds.length === 0) return fail('Choose the lots a landed cost relates to.');
    for (const lotId of line.landedCostLotIds) {
      const lot = lotById.get(lotId);
      if (!lot) return fail('A landed cost names a lot that does not belong to this entity.');
      const carriedIn = lot.location.account?.code ?? lot.item.account.code;
      if (carriedIn !== line.accountCode) return fail(`Lot ${lot.lotRef} is carried in ${carriedIn}; post the landed cost there.`);
    }
  }

  const linesData = form.lines.map((line, position) => ({
    entityId,
    position,
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: fromMinor(line.unitPrice),
    accountId: accountIdOf.get(line.accountCode) as string,
    vatTreatment: vatToPrisma[line.vatTreatment],
    itemId: line.itemId,
    locationId: line.locationId,
    landedCostKind: line.landedCostKind ? landedToPrisma[line.landedCostKind] : null,
    lotRef: line.lotRef.trim() || null,
    community: line.community.trim() || null,
    district: line.district.trim() || null,
    qualityJson: Object.keys(line.quality).length ? JSON.stringify(line.quality) : null,
    landedCostLots: line.landedCostKind ? { create: line.landedCostLotIds.map((lotId) => ({ entityId, lotId })) } : undefined,
  }));

  // The id must belong to *this* entity. One that does not — whether it is
  // another entity's document or nonsense — is refused the same way, as a
  // value, before the transaction opens.
  if (form.id) {
    const owned = await prisma.document.count({ where: { id: form.id, entityId } });
    if (owned !== 1) {
      return fail('Document not found.');
    }
  }

  const row = await prisma.$transaction(async (tx) => {
    if (form.id) {
      const existing = await tx.document.findFirst({ where: { id: form.id, entityId }, select: { status: true } });
      if (!existing) {
        throw new Error('Document not found'); // raced a concurrent change; unreachable in practice
      }
      if (existing.status !== 'DRAFT') {
        // Not an error: the autosave raced a post. Return what is there.
        return tx.document.findUniqueOrThrow({ where: { id: form.id }, include: documentInclude });
      }

      await tx.landedCostAllocation.deleteMany({ where: { documentLine: { documentId: form.id } } });
      await tx.documentLine.deleteMany({ where: { documentId: form.id } });
      return tx.document.update({
        where: { id: form.id },
        data: {
          contactId: form.contactId,
          date: dateOf(form.date),
          dueDate: dateOf(form.dueDate),
          evatClearanceNumber: form.evatClearanceNumber || null,
          evatQrCode: form.evatQrCode || null,
          evatTimestamp: form.evatTimestamp || null,
          ...rateFields,
          ...vatFields,
          lastEditedById: principal.userId,
          lines: { create: linesData },
        },
        include: documentInclude,
      });
    }

    return tx.document.create({
      data: {
        entityId,
        kind: kindToPrisma[kind],
        number: null, // allocated on posting; NULL keeps the unique index off drafts
        contactId: form.contactId,
        date: dateOf(form.date),
        dueDate: dateOf(form.dueDate),
        status: 'DRAFT',
        evatClearanceNumber: form.evatClearanceNumber || null,
        evatQrCode: form.evatQrCode || null,
        evatTimestamp: form.evatTimestamp || null,
        ...rateFields,
        ...vatFields,
        createdById: principal.userId,
        lastEditedById: principal.userId,
        lines: { create: linesData },
      },
      include: documentInclude,
    });
  });

  // Drafts are not audited (the audit trail is for the ledger); the editor's
  // identity is on the row.
  refresh();
  return { ok: true, value: documentRecord(row) };
}

// --- posting -----------------------------------------------------------------------

/**
 * Post a draft: allocate its number, write a balanced journal dated the
 * document's date, and record the audit event — all in one transaction.
 *
 * The status change is a guarded updateMany on DRAFT, so two concurrent
 * posts of the same document produce exactly one journal.
 */
export async function postDocument(entityId: string, documentId: string): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) => post(entityId, documentId, principal));
}

async function post(entityId: string, documentId: string, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  const entity = await requireEntity(entityId);

  const document = await prisma.document.findFirst({
    where: { id: documentId, entityId },
    include: { ...documentInclude, contact: true },
  });
  if (!document) {
    return fail('Document not found.');
  }
  if (document.status !== 'DRAFT') {
    return fail('Only a draft can be posted.');
  }
  if (document.lines.length === 0) {
    return fail('Add at least one line before posting.');
  }

  const period = periodOf(document.date.toISOString());
  const filed = await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } });
  if (filed) {
    return fail(`Period ${period} has been filed. Date the document in an open period.`);
  }

  const accounts = await prisma.account.findMany({ where: { entityId, isActive: true }, select: { id: true, code: true, name: true } });
  const accountIdOf = new Map(accounts.map((account) => [account.code, account.id]));
  const names = accountNameMap(accounts);

  const isPurchase = document.kind === 'BILL';
  const contact = contactRecord({ ...document.contact, balances: [] });
  const form = documentRecordToForm(documentRecord(document));
  // Whether VAT applies is decided here, from the entity's registration and
  // the document's date — never from the draft's earlier answer — and stored
  // on the document with the journal.
  const tax = documentTaxFor(entity, form.date);
  const txnLines = journalLinesFor(form, isPurchase, contact, names, tax);

  if (!journalEntriesBalance([{ entityId, lines: txnLines }])) {
    // Cannot happen if the builder is correct; refuse loudly rather than
    // write an unbalanced entry.
    throw new Error('Journal does not balance; refusing to post');
  }

  // The rate is fixed here, at posting, and stored on the document and every
  // line. Rounding differences land on the control account so the functional
  // journal balances exactly too.
  const rateInfo = await rateForDraft(entityId, form, entity.functionalCurrency);
  if (!rateInfo) {
    return fail(`No ${form.currency}→${entity.functionalCurrency} exchange rate is on file on or before ${form.date}. Enter one under Settings, or type a rate on the document.`);
  }
  const lines = convertJournal(txnLines, form.currency, entity.functionalCurrency, rateInfo.rate, isPurchase ? controlAccounts.payables : controlAccounts.receivables);
  if (!journalEntriesBalance([{ entityId, lines: lines.map((line) => ({ ...line, amount: line.functionalAmount })) }])) {
    throw new Error('Converted journal does not balance; refusing to post');
  }

  for (const line of lines) {
    if (!accountIdOf.has(line.accountCode)) {
      return fail(`Account ${line.accountCode} is not in this entity's chart.`);
    }
  }

  const kind = document.kind === 'BILL' ? 'bill' : 'invoice';

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.document.updateMany({
        where: { id: documentId, entityId, status: 'DRAFT' },
        data: { status: 'AWAITING_PAYMENT' },
      });
      if (claimed.count !== 1) {
        throw new AlreadyPostedError();
      }

      const counter = await tx.documentCounter.upsert({
        where: { entityId_kind: { entityId, kind: document.kind } },
        create: { entityId, kind: document.kind, next: 2 },
        update: { next: { increment: 1 } },
        select: { next: true },
      });
      const number = `${kind === 'invoice' ? 'INV' : 'BILL'}-${String(counter.next - 1).padStart(4, '0')}`;

      const entry = await tx.journalEntry.create({
        data: {
          entityId,
          kind: 'DOCUMENT',
          reference: number,
          description: `${documentLabel(kind, number)} — ${document.contact.name}`,
          postedAt: document.date,
          postedById: principal.userId,
          lines: {
            create: lines.map((line) => lineData(entityId, line, accountIdOf.get(line.accountCode) as string, document.contactId)),
          },
        },
        select: { id: true },
      });

      await tx.document.update({
        where: { id: documentId },
        data: {
          number,
          journalEntryId: entry.id,
          rate: decimalOf(rateInfo.rate),
          rateDate: dateOf(rateInfo.rateDate),
          rateExact: rateInfo.rateExact,
          vatApplied: tax.vatApplies,
        },
      });

      // Receipts: each stock line adds to its location exactly its share of
      // what this journal debited to its inventory account. The bill's
      // journal is the receipt's ledger posting; nothing posts twice, and
      // stock value equals the ledger by construction.
      const stockLines = document.lines.filter((line) => line.itemId && line.locationId);
      if (stockLines.length > 0) {
        const items = await tx.item.findMany({ where: { id: { in: stockLines.map((line) => line.itemId as string) }, entityId }, include: { account: { select: { code: true } } } });
        const itemById = new Map(items.map((item) => [item.id, item]));
        const inventoryCodes = new Set(items.map((item) => item.account.code));
        const functionalByAccount: Record<string, number> = {};
        for (const line of lines) {
          if (line.type === 'debit' && inventoryCodes.has(line.accountCode)) {
            functionalByAccount[line.accountCode] = (functionalByAccount[line.accountCode] ?? 0) + line.functionalAmount;
          }
        }
        const shares = allocateReceiptValues(
          document.lines
            .filter((line) => inventoryCodes.has(line.account.code))
            .map((line) => ({ lineId: line.id, accountCode: line.account.code, baseMinor: roundPesewas(line.quantity * toMinor(line.unitPriceMinor)) })),
          functionalByAccount,
        );
        for (const line of stockLines) {
          const item = itemById.get(line.itemId as string);
          if (!item) throw new StockRefusal('A line names a stock item that does not belong to this entity.');
          const factors = { baseUnit: unitToRecord[item.baseUnit], gramsPerBag: item.gramsPerBag, gramsPerCarton: item.gramsPerCarton };
          const grams = toGrams(line.quantity, factors.baseUnit, factors);
          if (grams <= 0) throw new StockRefusal(`${item.code}: the quantity rounds to nothing.`);
          const value = shares[line.id] ?? 0;
          await moveBalance(tx, entityId, item.id, line.locationId as string, grams, value);
          const movement = await tx.stockMovement.create({
            data: {
              entityId, kind: 'RECEIPT', date: document.date, itemId: item.id, toLocationId: line.locationId,
              quantityGrams: fromMinor(grams), valueMinor: fromMinor(value),
              documentId, documentLineId: line.id, journalEntryId: entry.id, createdById: principal.userId,
              note: `${documentLabel(kind, number)}: ${formatKg(grams)} ${item.name}`,
            },
            select: { id: true },
          });
          // Every receipt of a commodity grade is a lot: origin and quality for traceability, quantity only.
          if (item.commodityId) {
            const quality = line.qualityJson ? (JSON.parse(line.qualityJson) as Record<string, unknown>) : {};
            const lotRef = line.lotRef?.trim() || `${number}-${line.position + 1}`;
            const lot = await tx.lot.create({
              data: {
                entityId, commodityId: item.commodityId, itemId: item.id, locationId: line.locationId as string, lotRef, date: document.date,
                supplierContactId: document.contactId, community: line.community, district: line.district,
                kor: typeof quality.kor === 'number' ? new Prisma.Decimal(quality.kor) : null,
                moisturePct: typeof quality.moisturePct === 'number' ? new Prisma.Decimal(quality.moisturePct) : null,
                nutCount: typeof quality.nutCount === 'number' ? Math.round(quality.nutCount) : null,
                cocoaGrade: typeof quality.cocoaGrade === 'string' ? quality.cocoaGrade : null,
                beanCount: typeof quality.beanCount === 'number' ? Math.round(quality.beanCount) : null,
                gramsIn: fromMinor(grams), documentLineId: line.id, createdById: principal.userId,
              },
              select: { id: true },
            });
            await tx.stockMovement.update({ where: { id: movement.id }, data: { lotId: lot.id } });
          }
        }
      }

      // Landed cost: each such line's functional share of its account's debit is
      // spread per kilogram over the lots it names — value up, quantity unchanged.
      const landedLines = document.lines.filter((line) => line.landedCostKind && line.landedCostLots.length > 0);
      if (landedLines.length > 0) {
        const codesTouched = new Set(landedLines.map((line) => line.account.code));
        const functionalByAccount: Record<string, number> = {};
        for (const line of lines) {
          if (line.type === 'debit' && codesTouched.has(line.accountCode)) functionalByAccount[line.accountCode] = (functionalByAccount[line.accountCode] ?? 0) + line.functionalAmount;
        }
        const lineShares = allocateReceiptValues(
          document.lines.filter((line) => codesTouched.has(line.account.code)).map((line) => ({ lineId: line.id, accountCode: line.account.code, baseMinor: roundPesewas(line.quantity * toMinor(line.unitPriceMinor)) })),
          functionalByAccount,
        );
        for (const line of landedLines) {
          const lots = await tx.lot.findMany({ where: { id: { in: line.landedCostLots.map((a) => a.lotId) }, entityId }, select: { id: true, itemId: true, locationId: true, gramsIn: true, lotRef: true } });
          const shares = allocateByWeight(lineShares[line.id] ?? 0, lots.map((lot) => ({ key: lot.id, grams: toMinor(lot.gramsIn) })));
          for (const lot of lots) {
            const share = shares[lot.id] ?? 0;
            if (share === 0) continue;
            await moveBalance(tx, entityId, lot.itemId, lot.locationId, 0, share);
            await tx.lot.update({ where: { id: lot.id }, data: { landedCostMinor: { increment: fromMinor(share) } } });
            await tx.landedCostAllocation.update({ where: { documentLineId_lotId: { documentLineId: line.id, lotId: lot.id } }, data: { valueMinor: fromMinor(share) } });
            await tx.stockMovement.create({
              data: { entityId, kind: 'LANDED_COST', date: document.date, itemId: lot.itemId, toLocationId: lot.locationId, quantityGrams: 0n, valueMinor: fromMinor(share), lotId: lot.id, documentId, documentLineId: line.id, journalEntryId: entry.id, createdById: principal.userId, note: `${documentLabel(kind, number)}: ${line.landedCostKind?.toLowerCase()} on lot ${lot.lotRef}` },
            });
          }
        }
      }

      await recordAuditEvent(
        {
          entityId,
          userId: principal.userId,
          userName: principal.name,
          action: 'POST',
          resourceType: kind,
          resourceRef: number,
          summary: `${documentLabel(kind, number)} posted for ${document.contact.name}`,
          metadata: {
            journalEntryId: entry.id,
            lines: lines.length,
            currency: form.currency,
            rate: rateInfo.rate,
            vatApplied: tax.vatApplies,
            saleType: form.saleType,
            importVat: form.importVat,
            total: lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.functionalAmount, 0),
          },
        },
        tx,
      );
    });
  } catch (error) {
    if (error instanceof AlreadyPostedError) {
      return fail('This document was already posted.');
    }
    if (error instanceof StockRefusal) {
      return fail(error.message);
    }
    throw error;
  }

  const posted = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, include: documentInclude });
  refresh();
  return { ok: true, value: documentRecord(posted) };
}

class AlreadyPostedError extends Error {}

function documentRecordToForm(record: DocumentRecord): DocumentFormState {
  return {
    id: record.id,
    kind: record.kind,
    docNumber: record.docNumber,
    contactId: record.contactId,
    date: record.date,
    dueDate: record.dueDate,
    status: record.status,
    currency: record.currency,
    rate: record.rate,
    rateDate: record.rateDate,
    rateExact: record.rateExact,
    saleType: record.saleType,
    importVat: record.importVat,
    lines: record.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountCode: line.accountCode,
      vatTreatment: line.vatTreatment,
      itemId: line.itemId,
      locationId: line.locationId,
      landedCostKind: line.landedCostKind,
      landedCostLotIds: line.landedCostLotIds,
      lotRef: line.lotRef,
      community: line.community,
      district: line.district,
      quality: line.quality,
    })),
    evatClearanceNumber: record.evatClearanceNumber,
    evatQrCode: record.evatQrCode,
    evatTimestamp: record.evatTimestamp,
  };
}

// --- payments: settlement with realised FX ------------------------------------------

export type PaymentInput = {
  documentId: string;
  bankAccountId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Amount settled, in the document's currency, minor units. */
  txnAmount: number;
  /** Settlement rate: functional per 1 unit of document currency. Ignored for functional-currency documents. */
  rate: string;
};

/**
 * Record a payment against a posted document and post its journal: the bank
 * at the settlement rate, the receivable or payable relieved at the
 * document's historic rate, and the difference to realised FX gain/loss.
 * The document's functional amount is never touched — the gain or loss is
 * a new fact, booked on the payment date.
 */
export async function recordPayment(entityId: string, input: PaymentInput): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:mark-paid', (principal) => settle(entityId, input, principal));
}

async function settle(entityId: string, input: PaymentInput, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  const entity = await requireEntity(entityId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return fail('Payment date must be YYYY-MM-DD.');
  if (!Number.isInteger(input.txnAmount) || input.txnAmount <= 0) return fail('Enter a payment amount greater than zero.');

  const period = periodOf(input.date);
  if (await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
    return fail(`Period ${period} has been filed. Date the payment in an open period.`);
  }

  const document = await prisma.document.findFirst({
    where: { id: input.documentId, entityId },
    include: { ...documentInclude, contact: true },
  });
  if (!document) return fail('Document not found.');
  if (document.status !== 'AWAITING_PAYMENT') return fail('Only a posted, unpaid document can be settled.');
  if (!document.journalEntry || !document.rate) return fail('This document has no posted journal to settle.');

  const bank = await prisma.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: true } });
  if (!bank) return fail('Choose a bank account belonging to this entity.');

  const kind = document.kind === 'BILL' ? 'bill' : 'invoice';
  const form = documentRecordToForm(documentRecord(document));
  const contact = contactRecord({ ...document.contact, balances: [] });
  // The regime fixed at posting, not today's: registering later must not change what is owed.
  const totals = buildTotals(form, kind === 'bill' ? contact.withholdingTaxStatus : undefined, { vatApplies: document.vatApplied });
  const owedTxn = kind === 'invoice' ? totals.total : totals.netPayable;
  const paidSoFar = toMinor(document.paidTxnMinor);
  const outstanding = owedTxn - paidSoFar;
  if (input.txnAmount > outstanding) {
    return fail(`That is more than the ${outstanding / 100} ${document.currency} still outstanding.`);
  }
  const isFinal = input.txnAmount === outstanding;

  let settlementRate: string;
  try {
    settlementRate = document.currency === entity.functionalCurrency ? '1.0' : normalizeRate(input.rate);
  } catch {
    return fail('The settlement rate must be a positive decimal number.');
  }

  // Functional book value of this document's control-account balance still open:
  // what was posted, less what earlier payments relieved.
  const controlCode = kind === 'invoice' ? controlAccounts.receivables : controlAccounts.payables;
  const controlPosted = document.journalEntry.lines
    .filter((line) => line.account.code === controlCode)
    .reduce((sum, line) => sum + toMinor(line.amountMinor), 0);
  const relievedSoFar = document.payments.reduce((sum, payment) => sum + toMinor(payment.reliefMinor), 0);
  const remainingBookMinor = controlPosted - relievedSoFar;

  const accounts = await prisma.account.findMany({ where: { entityId, isActive: true }, select: { id: true, code: true, name: true } });
  const accountIdOf = new Map(accounts.map((account) => [account.code, account.id]));
  const names = accountNameMap(accounts);

  let settlement;
  try {
    settlement = settlementFor({
      kind,
      documentCurrency: document.currency,
      functionalCurrency: entity.functionalCurrency,
      documentRate: rateText(document.rate) ?? '1.0',
      txnAmount: input.txnAmount,
      settlementRate,
      bankCurrency: bank.currency,
      remainingBookMinor,
      isFinal,
      controlAccountCode: controlCode,
      bankAccountCode: bank.account.code,
      names,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Could not compute the settlement.');
  }
  for (const line of settlement.lines) {
    if (!accountIdOf.has(line.accountCode)) return fail(`Account ${line.accountCode} is not in this entity's chart.`);
  }

  const number = postedNumberOf(document);
  const row = await prisma.$transaction(async (tx) => {
    // Claim the outstanding amount atomically: two concurrent settlements of
    // the same balance cannot both succeed.
    const claimed = await tx.document.updateMany({
      where: { id: document.id, entityId, status: 'AWAITING_PAYMENT', paidTxnMinor: document.paidTxnMinor },
      data: { paidTxnMinor: { increment: fromMinor(input.txnAmount) }, ...(isFinal ? { status: 'PAID' as const } : {}) },
    });
    if (claimed.count !== 1) throw new AlreadyPostedError();

    const entry = await tx.journalEntry.create({
      data: {
        entityId,
        kind: 'PAYMENT',
        reference: number,
        description: `Payment ${kind === 'invoice' ? 'received for' : 'made for'} ${documentLabel(kind, number)} — ${document.contact.name}`,
        postedAt: dateOf(input.date),
        postedById: principal.userId,
        lines: { create: settlement.lines.map((line) => lineData(entityId, line, accountIdOf.get(line.accountCode) as string, document.contactId)) },
      },
      select: { id: true },
    });

    await tx.payment.create({
      data: {
        entityId,
        documentId: document.id,
        bankAccountId: bank.id,
        date: dateOf(input.date),
        txnAmountMinor: fromMinor(input.txnAmount),
        rate: decimalOf(settlementRate),
        bankAmountMinor: fromMinor(settlement.bankAmountMinor),
        bankFunctionalMinor: fromMinor(settlement.bankFunctionalMinor),
        reliefMinor: fromMinor(settlement.reliefMinor),
        gainLossMinor: fromMinor(settlement.gainLossMinor),
        journalEntryId: entry.id,
        recordedById: principal.userId,
      },
    });

    const gainText =
      settlement.gainLossMinor === 0
        ? ''
        : `; realised FX ${settlement.gainLossMinor > 0 ? 'gain' : 'loss'} ${Math.abs(settlement.gainLossMinor) / 100} ${entity.functionalCurrency}`;
    await recordAuditEvent(
      {
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'EDIT',
        resourceType: kind,
        resourceRef: number,
        summary: `${documentLabel(kind, number)}: ${input.txnAmount / 100} ${document.currency} ${kind === 'invoice' ? 'received' : 'paid'} at ${settlementRate}${gainText}${isFinal ? '; settled in full' : ''}`,
        metadata: {
          journalEntryId: entry.id,
          bankAccountId: bank.id,
          txnAmount: input.txnAmount,
          rate: settlementRate,
          relief: settlement.reliefMinor,
          bankFunctional: settlement.bankFunctionalMinor,
          gainLoss: settlement.gainLossMinor,
        },
      },
      tx,
    );

    return tx.document.findUniqueOrThrow({ where: { id: document.id }, include: documentInclude });
  }).catch((error) => {
    if (error instanceof AlreadyPostedError) return null;
    throw error;
  });

  if (!row) return fail('This document changed while you were recording the payment. Reload and try again.');

  refresh();
  return { ok: true, value: documentRecord(row) };
}

// --- void --------------------------------------------------------------------------

/**
 * Void a posted document by writing a reversing journal dated today. The
 * original entry is untouched — nothing is deleted. Refused if today's period
 * has been filed, because the reversal has to land in an open period.
 */
export async function voidDocument(entityId: string, documentId: string): Promise<ActionResult<DocumentRecord>> {
  return withEntityAccess(entityId, 'document:void', (principal) => voidPosted(entityId, documentId, principal));
}

async function voidPosted(entityId: string, documentId: string, principal: Principal): Promise<ActionResult<DocumentRecord>> {
  await requireEntity(entityId);

  const today = todayIso();
  const filed = await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period: periodOf(today) } } });
  if (filed) {
    return fail(`Period ${periodOf(today)} has been filed, so a reversal cannot be dated today.`);
  }

  const document = await prisma.document.findFirst({
    where: { id: documentId, entityId },
    include: { journalEntry: { include: { lines: true } }, contact: { select: { name: true } } },
  });
  if (!document) {
    return fail('Document not found.');
  }
  if (document.status === 'VOIDED') {
    return fail('This document is already voided.');
  }
  if (document.status === 'DRAFT' || !document.journalEntry) {
    return fail('A draft has nothing to reverse; delete its lines instead.');
  }
  if (document.paidTxnMinor > 0n) {
    return fail('This document has payments recorded against it. Reverse those first.');
  }

  const kind = document.kind === 'BILL' ? 'bill' : 'invoice';
  const number = postedNumberOf(document);
  const original = document.journalEntry;

  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.document.updateMany({
      where: { id: documentId, entityId, status: { in: ['AWAITING_PAYMENT', 'PAID'] } },
      data: { status: 'VOIDED' },
    });
    if (claimed.count !== 1) {
      throw new AlreadyPostedError();
    }

    const reversal = await tx.journalEntry.create({
      data: {
        entityId,
        kind: 'REVERSAL',
        reference: number,
        description: `Reversal of ${documentLabel(kind, number)} — ${document.contact.name}`,
        postedAt: dateOf(today),
        reversalOfId: original.id,
        postedById: principal.userId,
        lines: {
          create: original.lines.map((line) => ({
            entityId,
            accountId: line.accountId,
            fundId: line.fundId,
            projectId: line.projectId,
            contactId: line.contactId,
            txnCurrency: line.txnCurrency,
            txnAmountMinor: line.txnAmountMinor,
            rate: line.rate, // the original rate: a reversal undoes history at history's rate
            amountMinor: line.amountMinor,
            direction: line.direction === 'MONEY_IN' ? 'MONEY_OUT' : 'MONEY_IN',
          })),
        },
      },
      select: { id: true },
    });

    await tx.document.update({ where: { id: documentId }, data: { voidEntryId: reversal.id } });

    // Stock received from this bill leaves again, at the value it came in
    // at, so stock and the reversed ledger stay equal. If it has since been
    // moved or consumed, the void is refused rather than taking a location
    // negative — adjust the stock first.
    const receipts = await tx.stockMovement.findMany({ where: { documentId, kind: { in: ['RECEIPT', 'LANDED_COST'] }, reversedBy: null }, include: { item: { select: { code: true } } } });
    for (const receipt of receipts) {
      const grams = toMinor(receipt.quantityGrams);
      const value = toMinor(receipt.valueMinor);
      try {
        await moveBalance(tx, entityId, receipt.itemId, receipt.toLocationId as string, -grams, -value);
      } catch (error) {
        if (error instanceof StockRefusal) throw new StockRefusal(`${receipt.item.code}: ${error.message} Adjust the stock before voiding this bill.`);
        throw error;
      }
      await tx.stockMovement.create({
        data: {
          entityId, kind: 'RECEIPT_REVERSAL', date: dateOf(today), itemId: receipt.itemId, fromLocationId: receipt.toLocationId,
          quantityGrams: fromMinor(-grams), valueMinor: fromMinor(-value), documentId, documentLineId: receipt.documentLineId, lotId: receipt.lotId,
          journalEntryId: reversal.id, reversesId: receipt.id, createdById: principal.userId, note: `Void of ${documentLabel(kind, number)}`,
        },
      });
      if (receipt.lotId && receipt.kind === 'LANDED_COST') {
        await tx.lot.update({ where: { id: receipt.lotId }, data: { landedCostMinor: { decrement: fromMinor(value) } } });
      }
    }

    await recordAuditEvent(
      {
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'VOID',
        resourceType: kind,
        resourceRef: number,
        summary: `${documentLabel(kind, number)} voided; reversal dated ${today}`,
        metadata: { reversalOf: original.id, reversalEntryId: reversal.id },
      },
      tx,
    );

    return tx.document.findUniqueOrThrow({ where: { id: documentId }, include: documentInclude });
  }).catch((error) => {
    if (error instanceof AlreadyPostedError) return null;
    if (error instanceof StockRefusal) return error;
    throw error;
  });

  if (row instanceof StockRefusal) {
    return fail(row.message);
  }
  if (!row) {
    return fail('This document changed while you were voiding it. Reload and try again.');
  }

  refresh();
  return { ok: true, value: documentRecord(row) };
}

// --- periods -----------------------------------------------------------------------

export async function fileTaxPeriod(entityId: string, period: string): Promise<ActionResult<string[]>> {
  return withEntityAccess(entityId, 'period:file', (principal) => filePeriod(entityId, period, principal));
}

async function filePeriod(entityId: string, period: string, principal: Principal): Promise<ActionResult<string[]>> {
  await requireEntity(entityId);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return fail('Period must be YYYY-MM.');
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } });
    if (existing) return;

    await tx.taxPeriodFiling.create({ data: { entityId, period, filedBy: principal.name, filedById: principal.userId } });
    await recordAuditEvent(
      {
        entityId,
        userId: principal.userId,
        userName: principal.name,
        action: 'FILE_PERIOD',
        resourceType: 'vat-period',
        resourceRef: period,
        summary: `VAT period ${period} filed and locked`,
      },
      tx,
    );
  });

  const periods = await prisma.taxPeriodFiling.findMany({ where: { entityId }, select: { period: true }, orderBy: { period: 'asc' } });
  refresh();
  return { ok: true, value: periods.map((filing) => filing.period) };
}

// --- contacts and entities ---------------------------------------------------------

export type NewContactInput = {
  name: string;
  type: ContactRecord['type'];
  category: ContactRecord['category'];
  tin: string;
  phone: string;
  email: string;
  address: string;
  withholdingTaxStatus: WithholdingTaxStatus;
  isFarmerAggregator: boolean;
};

// Contacts are shared across the group, so this is a role check, not an
// entity one: anyone who can draft a document can add the contact it needs.
export async function createContact(input: NewContactInput): Promise<ActionResult<ContactRecord>> {
  return withPermission('contact:create', () => addContact(input));
}

async function addContact(input: NewContactInput): Promise<ActionResult<ContactRecord>> {
  const name = input.name.trim();
  if (!name) {
    return fail('A contact needs a name.');
  }

  const entities = await prisma.entity.findMany({ select: { id: true } });

  const row = await prisma.contact.create({
    data: {
      name,
      type: toPrismaEnum.contactType[input.type],
      category: toPrismaEnum.contactCategory[input.category],
      tin: input.tin.trim() || null,
      phone: input.phone.trim() || null,
      email: input.email.trim() || null,
      address: input.address.trim() || null,
      withholdingTaxStatus: toPrismaEnum.withholdingTaxStatus[input.withholdingTaxStatus],
      isFarmerAggregator: input.isFarmerAggregator,
      balances: { create: entities.map((entity) => ({ entityId: entity.id, balanceMinor: BigInt(0) })) },
    },
    include: { balances: true },
  });

  refresh();
  return { ok: true, value: contactRecord(row) };
}

export type NewEntityInput = {
  name: string;
  type: EntityType;
  financialYearEnd: string;
  vatRegistered: boolean;
  /** YYYY-MM-DD; required when vatRegistered. */
  vatRegisteredFrom?: string;
  tin: string;
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Create an entity with a full chart of accounts from the template for its
 * type, plus the group-entity contact the other entities trade with it
 * through. No schema change is needed for a fourth, fifth or tenth entity.
 */
export async function createEntity(input: NewEntityInput): Promise<ActionResult<{ entity: EntityRecord; contact: ContactRecord }>> {
  return withPermission('entity:create', () => addEntity(input));
}

async function addEntity(input: NewEntityInput): Promise<ActionResult<{ entity: EntityRecord; contact: ContactRecord }>> {
  const name = input.name.trim();
  if (!name) {
    return fail('An entity needs a name.');
  }

  const registeredFrom = input.vatRegistered ? (input.vatRegisteredFrom ?? '').trim() : '';
  if (input.vatRegistered && !/^\d{4}-\d{2}-\d{2}$/.test(registeredFrom)) {
    return fail('A VAT-registered entity needs its registration date (YYYY-MM-DD).');
  }

  const base = slugify(name) || 'entity';
  const existingCount = await prisma.entity.count();

  const result = await prisma.$transaction(async (tx) => {
    let id = base;
    for (let suffix = 2; await tx.entity.findUnique({ where: { id }, select: { id: true } }); suffix += 1) {
      id = `${base}-${suffix}`;
    }

    const entity = await tx.entity.create({
      data: {
        id,
        code: `SG${String(existingCount + 1).padStart(3, '0')}`,
        name,
        type: input.type,
        financialYearEnd: input.financialYearEnd.trim() || null,
        vatRegistered: input.vatRegistered,
        vatRegisteredFrom: input.vatRegistered ? dateOf(registeredFrom) : null,
        tin: input.tin.trim() || null,
        accent: accentPalette[existingCount % accentPalette.length],
      },
    });

    await seedChartForEntity(tx, entity.id, input.type);
    await ensureDefaultBankAccount(tx, entity.id);

    // Every existing contact gets a zero balance with the new entity, and the
    // new entity gets a group-entity contact everyone else can trade with.
    const contacts = await tx.contact.findMany({ select: { id: true } });
    await tx.contactEntityBalance.createMany({
      data: contacts.map((contact) => ({ contactId: contact.id, entityId: entity.id, balanceMinor: BigInt(0) })),
    });

    const allEntities = await tx.entity.findMany({ select: { id: true } });
    const groupContact = await tx.contact.create({
      data: {
        id: `${id}-contact`,
        name,
        type: 'SUPPLIER',
        category: 'GROUP_ENTITY',
        tin: input.tin.trim() || null,
        withholdingTaxStatus: 'WHT_5',
        balances: { create: allEntities.map((e) => ({ entityId: e.id, balanceMinor: BigInt(0) })) },
      },
      include: { balances: true },
    });

    return { entity, groupContact };
  });

  refresh();
  return { ok: true, value: { entity: entityRecord(result.entity), contact: contactRecord(result.groupContact) } };
}
