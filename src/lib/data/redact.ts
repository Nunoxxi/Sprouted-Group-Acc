/**
 * The one place personal data is held back before it leaves the server.
 *
 * Everything the app knows is assembled in loadInitialData and sent to the
 * browser. Hiding a telephone number in the interface would not be hiding it
 * at all — it would still be sitting in the page source. So it is taken out
 * here, on the server, before the page is built.
 *
 * Two passes, in this order:
 *
 *  1. Contact details are masked for everybody, whatever their role. Nobody
 *     needs a farmer's mobile money number on the screen in order to see
 *     that the farmer was paid. Whoever does need it asks for it through
 *     revealPersonalDetail, which shows one number and writes down that it
 *     was shown. That is what makes the record of who looked worth having.
 *  2. Names and payroll are then held back from anyone who may not see
 *     personal details at all — a Viewer sees the accounting record, not the
 *     list of who earns what.
 *
 * A farmer's signature or thumbprint never appears here because it never
 * leaves the database: src/lib/data/trading.ts does not put it in the DTO.
 */

import { canSeePersonalDetail, maskEmail, maskNumber } from '../privacy';
import type { Role } from '../authz';
import type { InitialData } from './types';

const mapValues = <T>(record: Record<string, T[]>, transform: (row: T) => T): Record<string, T[]> =>
  Object.fromEntries(Object.entries(record).map(([key, rows]) => [key, rows.map(transform)]));

/**
 * Mask every contact detail. Numbers keep their last four digits so that one
 * person can still be told from another with the same name, and so that
 * somebody checking a payment can see it went to the right wallet without
 * the whole number being on display.
 */
function maskContactDetails(data: InitialData): InitialData {
  return {
    ...data,
    contacts: data.contacts.map((contact) => ({
      ...contact,
      phone: maskNumber(contact.phone),
      email: maskEmail(contact.email),
      address: contact.address ? '•••' : '',
      tin: maskNumber(contact.tin, 3),
    })),
    farmersByEntity: mapValues(data.farmersByEntity, (farmer) => ({
      ...farmer,
      phone: maskNumber(farmer.phone),
      walletNumber: maskNumber(farmer.walletNumber),
    })),
    agentsByEntity: mapValues(data.agentsByEntity, (agent) => ({ ...agent, phone: maskNumber(agent.phone) })),
    // An employee's tax and pension numbers, and where their pay goes. The
    // statutory schedules are exported from the database with the numbers in
    // full; on screen, as with a contact, the last digits are enough.
    employeesByEntity: mapValues(data.employeesByEntity, (employee) => ({
      ...employee,
      email: maskEmail(employee.email),
      tin: maskNumber(employee.tin, 3),
      ssnitNumber: maskNumber(employee.ssnitNumber, 3),
      bankAccountNumber: maskNumber(employee.bankAccountNumber),
      momoNumber: maskNumber(employee.momoNumber),
    })),
    payFactsByEntity: mapValues(data.payFactsByEntity, (fact) => ({ ...fact, tin: fact.tin ? maskNumber(fact.tin, 3) : null, ssnitNumber: fact.ssnitNumber ? maskNumber(fact.ssnitNumber, 3) : null })),
    paymentBatchesByEntity: mapValues(data.paymentBatchesByEntity, (batch) => ({
      ...batch,
      payments: batch.payments.map((payment) => ({ ...payment, walletNumber: maskNumber(payment.walletNumber) })),
    })),
  };
}

/** What somebody who may not see personal details never receives at all. */
function withholdFromViewers(data: InitialData): InitialData {
  return {
    ...data,
    agentPurchasesByEntity: mapValues(data.agentPurchasesByEntity, (purchase) => ({ ...purchase, paymentRef: maskNumber(purchase.paymentRef, 4) })),
    staffTimeByEntity: mapValues(data.staffTimeByEntity, (row) => ({ ...row, personName: maskNumber(row.personName, 0) })),
    // Who is paid what. The loader sends none of it without payroll:view;
    // this makes sure, whatever the loader is later changed to do.
    employeesByEntity: Object.fromEntries(Object.keys(data.employeesByEntity).map((id) => [id, []])),
    payRunsByEntity: Object.fromEntries(Object.keys(data.payRunsByEntity).map((id) => [id, []])),
    staffLoansByEntity: Object.fromEntries(Object.keys(data.staffLoansByEntity).map((id) => [id, []])),
    payFactsByEntity: Object.fromEntries(Object.keys(data.payFactsByEntity).map((id) => [id, []])),
    assetsByEntity: mapValues(data.assetsByEntity, (asset) => ({ ...asset, custodian: asset.custodian ? maskNumber(asset.custodian, 0) : '' })),
    // A request names the person who made it. Whoever may not see a
    // telephone number may not see the list of people who asked about theirs.
    dataRequestsByEntity: Object.fromEntries(Object.keys(data.dataRequestsByEntity).map((entityId) => [entityId, []])),
    // Who looked, and when, still shows. Whose details they looked at does
    // not: the summary names a person, so only the reason survives.
    piiAccessByEntity: mapValues(data.piiAccessByEntity, (event) => ({ ...event, summary: event.summary.split(':')[0], resourceRef: '' })),
  };
}

/** Both passes, in order. */
export function redactInitialData(data: InitialData, role: Role): InitialData {
  const masked = maskContactDetails(data);
  return canSeePersonalDetail(role) ? masked : withholdFromViewers(masked);
}

/**
 * The fields these passes cover, named so a test can check the register and
 * the code have not drifted apart. If a field is declared masked in
 * src/lib/privacy.ts and is not here, the test fails.
 */
export const redactedFields = [
  'Contact.phone',
  'Contact.email',
  'Contact.address',
  'Contact.tin',
  'Farmer.phone',
  'Farmer.walletNumber',
  'BuyingAgent.phone',
  'FarmerPayment.walletNumber',
  // Withheld outright rather than masked: it is never put in a DTO.
  'AgentPurchase.evidenceData',
  'AgentPurchase.paymentRef',
  'Employee.name',
  'Employee.email',
  'Employee.tin',
  'Employee.ssnitNumber',
  'Employee.bankAccountNumber',
  'Employee.momoNumber',
  'StaffTimeAllocation.personName',
  'FixedAsset.custodian',
];
