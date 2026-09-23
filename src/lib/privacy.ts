/**
 * Data protection: what personal data this app holds, who may see it, how it
 * is shown, and what happens when somebody asks for a copy of it or asks for
 * it to be erased.
 *
 * The map below is the single source of truth for the register the Data
 * Protection Commission asks for. It is written here, next to the code, so
 * that adding a field that holds personal data and forgetting to declare it
 * is a visible omission rather than an invisible one.
 *
 * Erasure is anonymisation, not deletion: accounting records have to be kept,
 * so what goes is the person's identity, not the money.
 *
 * Pure: no I/O, no Prisma.
 */

import type { Role } from './authz';

// --- the data map ----------------------------------------------------------------------------

/** Why the app holds a field at all. If this cannot be filled in, the field should not exist. */
export type Purpose =
  | 'pay-the-person'
  | 'contact-the-person'
  | 'prove-the-transaction'
  | 'account-for-the-money'
  | 'report-to-a-funder'
  | 'run-the-app';

export const purposeLabels: Record<Purpose, string> = {
  'pay-the-person': 'To pay them what they are owed',
  'contact-the-person': 'To reach them about their money or their delivery',
  'prove-the-transaction': 'To show a payment or a delivery actually happened',
  'account-for-the-money': 'To keep the accounting records the law requires',
  'report-to-a-funder': 'To report to a donor who funded the work',
  'run-the-app': 'To let someone sign in and to record what they did',
};

export type Sensitivity = 'identifier' | 'contact-detail' | 'location' | 'biometric' | 'financial';

export type PiiField = {
  /** The table it lives in. */
  model: string;
  field: string;
  /** Plain words for what it is. */
  describes: string;
  /** Whose data it is. */
  subject: 'farmer' | 'agent' | 'staff' | 'donor-or-supplier' | 'app-user';
  sensitivity: Sensitivity;
  purpose: Purpose;
  /** Stored encrypted, so the database alone does not give it up. */
  encrypted: boolean;
  /** Shown only in part unless somebody with the right role asks to see it. */
  masked: boolean;
  /** What erasure does to it. */
  onErasure: 'replaced-with-a-pseudonym' | 'removed' | 'kept';
};

/**
 * Every field in the app that is about an identifiable person. Names of
 * accounts, funds, projects, commodities and the entities themselves are not
 * here: they are not about people.
 */
export const dataMap: PiiField[] = [
  // --- farmers ---
  { model: 'Farmer', field: 'name', describes: "A farmer's name", subject: 'farmer', sensitivity: 'identifier', purpose: 'pay-the-person', encrypted: false, masked: false, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'Farmer', field: 'phone', describes: "A farmer's telephone number", subject: 'farmer', sensitivity: 'contact-detail', purpose: 'contact-the-person', encrypted: true, masked: true, onErasure: 'removed' },
  { model: 'Farmer', field: 'walletNumber', describes: "A farmer's mobile money number", subject: 'farmer', sensitivity: 'contact-detail', purpose: 'pay-the-person', encrypted: true, masked: true, onErasure: 'removed' },
  { model: 'Farmer', field: 'community', describes: 'The community a farmer farms in', subject: 'farmer', sensitivity: 'location', purpose: 'account-for-the-money', encrypted: false, masked: false, onErasure: 'kept' },
  { model: 'Farmer', field: 'district', describes: 'The district a farmer farms in', subject: 'farmer', sensitivity: 'location', purpose: 'account-for-the-money', encrypted: false, masked: false, onErasure: 'kept' },
  { model: 'AgentPurchase', field: 'farmerName', describes: 'The name on a delivery record', subject: 'farmer', sensitivity: 'identifier', purpose: 'prove-the-transaction', encrypted: false, masked: false, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'AgentPurchase', field: 'evidenceData', describes: "A farmer's signature or thumbprint, captured on a phone", subject: 'farmer', sensitivity: 'biometric', purpose: 'prove-the-transaction', encrypted: true, masked: true, onErasure: 'removed' },
  { model: 'AgentPurchase', field: 'paymentRef', describes: 'The mobile money reference for a payment to a farmer', subject: 'farmer', sensitivity: 'financial', purpose: 'prove-the-transaction', encrypted: false, masked: true, onErasure: 'kept' },
  { model: 'FarmerPayment', field: 'walletNumber', describes: 'The mobile money number a payment was sent to', subject: 'farmer', sensitivity: 'contact-detail', purpose: 'pay-the-person', encrypted: true, masked: true, onErasure: 'removed' },
  { model: 'FarmerAdvance', field: 'farmerName', describes: 'The name on an advance', subject: 'farmer', sensitivity: 'identifier', purpose: 'account-for-the-money', encrypted: false, masked: false, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'Lot', field: 'farmerName', describes: 'The name of the farmer a lot came from', subject: 'farmer', sensitivity: 'identifier', purpose: 'prove-the-transaction', encrypted: false, masked: false, onErasure: 'replaced-with-a-pseudonym' },

  // --- buying agents ---
  { model: 'BuyingAgent', field: 'name', describes: "A buying agent's name", subject: 'agent', sensitivity: 'identifier', purpose: 'account-for-the-money', encrypted: false, masked: false, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'BuyingAgent', field: 'phone', describes: "A buying agent's telephone number", subject: 'agent', sensitivity: 'contact-detail', purpose: 'contact-the-person', encrypted: true, masked: true, onErasure: 'removed' },

  // --- staff ---
  { model: 'PayrollLine', field: 'employeeName', describes: 'A member of staff on a payroll summary', subject: 'staff', sensitivity: 'identifier', purpose: 'account-for-the-money', encrypted: false, masked: true, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'PayrollLine', field: 'employeeRef', describes: 'Their staff reference', subject: 'staff', sensitivity: 'identifier', purpose: 'account-for-the-money', encrypted: false, masked: true, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'PayrollAllocation', field: 'employeeName', describes: 'A member of staff whose cost is split across grants', subject: 'staff', sensitivity: 'identifier', purpose: 'report-to-a-funder', encrypted: false, masked: true, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'StaffTimeAllocation', field: 'personName', describes: 'Whose time was charged to a grant', subject: 'staff', sensitivity: 'identifier', purpose: 'report-to-a-funder', encrypted: false, masked: true, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'FixedAsset', field: 'custodian', describes: 'Who is holding a piece of equipment', subject: 'staff', sensitivity: 'identifier', purpose: 'account-for-the-money', encrypted: false, masked: true, onErasure: 'replaced-with-a-pseudonym' },

  // --- donors, customers and suppliers who are people ---
  { model: 'Contact', field: 'name', describes: 'A customer, supplier or donor — sometimes a person, sometimes a company', subject: 'donor-or-supplier', sensitivity: 'identifier', purpose: 'account-for-the-money', encrypted: false, masked: false, onErasure: 'replaced-with-a-pseudonym' },
  { model: 'Contact', field: 'phone', describes: 'Their telephone number', subject: 'donor-or-supplier', sensitivity: 'contact-detail', purpose: 'contact-the-person', encrypted: true, masked: true, onErasure: 'removed' },
  { model: 'Contact', field: 'email', describes: 'Their email address', subject: 'donor-or-supplier', sensitivity: 'contact-detail', purpose: 'contact-the-person', encrypted: true, masked: true, onErasure: 'removed' },
  { model: 'Contact', field: 'address', describes: 'Their address', subject: 'donor-or-supplier', sensitivity: 'location', purpose: 'contact-the-person', encrypted: true, masked: true, onErasure: 'removed' },
  { model: 'Contact', field: 'tin', describes: 'Their tax identification number', subject: 'donor-or-supplier', sensitivity: 'financial', purpose: 'account-for-the-money', encrypted: false, masked: true, onErasure: 'kept' },

  // --- people who use the app ---
  { model: 'User', field: 'name', describes: 'The name of someone who uses the app', subject: 'app-user', sensitivity: 'identifier', purpose: 'run-the-app', encrypted: false, masked: false, onErasure: 'kept' },
  { model: 'User', field: 'email', describes: 'Their email address, which is how they sign in', subject: 'app-user', sensitivity: 'contact-detail', purpose: 'run-the-app', encrypted: false, masked: false, onErasure: 'kept' },
  { model: 'AuditEvent', field: 'userName', describes: 'Who did something in the app, kept permanently', subject: 'app-user', sensitivity: 'identifier', purpose: 'run-the-app', encrypted: false, masked: false, onErasure: 'kept' },
];

export const subjectLabels: Record<PiiField['subject'], string> = {
  farmer: 'Farmers',
  agent: 'Buying agents',
  staff: 'Staff',
  'donor-or-supplier': 'Donors, customers and suppliers',
  'app-user': 'People who use the app',
};

/** The map grouped by whose data it is, for the register and for the screen. */
export function dataMapBySubject(): { subject: PiiField['subject']; label: string; fields: PiiField[] }[] {
  return (Object.keys(subjectLabels) as PiiField['subject'][]).map((subject) => ({
    subject,
    label: subjectLabels[subject],
    fields: dataMap.filter((field) => field.subject === subject),
  }));
}

/** Which fields are kept encrypted. Used by the register and by a test that the code agrees with it. */
export function encryptedFields(): PiiField[] {
  return dataMap.filter((field) => field.encrypted);
}

// --- who may see what -------------------------------------------------------------------------

/**
 * Roles that may see a person's contact details in full. A Viewer sees that a
 * farmer exists and what they were paid — which is the accounting record —
 * but not how to telephone them.
 */
export const rolesWithPersonalDetail: Role[] = ['owner', 'accountant', 'data-entry'];

export function canSeePersonalDetail(role: Role): boolean {
  return rolesWithPersonalDetail.includes(role);
}

// --- masking -----------------------------------------------------------------------------------

/**
 * A telephone or mobile money number with only its last digits showing. Short
 * enough to recognise the right person, not enough to call them or to send
 * money to them.
 */
export function maskNumber(value: string | null | undefined, visible = 4): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length <= visible) return '•'.repeat(trimmed.length);
  return `${'•'.repeat(Math.max(trimmed.length - visible, 3))}${trimmed.slice(-visible)}`;
}

/** An email with only the first letter and the domain showing. */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return '';
  const [local, domain] = value.split('@');
  if (!domain) return maskNumber(value, 2);
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

/** Anything else: the first character and nothing more. */
export function maskText(value: string | null | undefined): string {
  if (!value) return '';
  return `${value.trim().slice(0, 1)}${'•'.repeat(Math.max(value.trim().length - 1, 3))}`;
}

/** Whether a value has already been masked, so it is never masked twice or stored masked. */
export function isMasked(value: string): boolean {
  return value.includes('•');
}

// --- recording who looked --------------------------------------------------------------------------

export type AccessReason = 'revealed-a-contact-detail' | 'subject-access-report' | 'exported-personal-data' | 'viewed-a-person-history' | 'erased-a-person';

export const accessReasonLabels: Record<AccessReason, string> = {
  'revealed-a-contact-detail': 'Showed a hidden telephone or mobile money number',
  'subject-access-report': 'Produced a report of everything held about a person',
  'exported-personal-data': 'Exported records containing personal data',
  'viewed-a-person-history': "Looked at one person's full history",
  'erased-a-person': 'Erased a person at their request',
};

/** The line that goes in the audit log when somebody looks at personal data. */
export function accessSummary(reason: AccessReason, subjectLabel: string, detail?: string): string {
  return `${accessReasonLabels[reason]}: ${subjectLabel}${detail ? ` — ${detail}` : ''}`;
}

// --- erasure ------------------------------------------------------------------------------------------

export type SubjectKind = 'farmer' | 'agent' | 'contact' | 'employee';
export const subjectKinds: SubjectKind[] = ['farmer', 'agent', 'contact', 'employee'];
export const subjectKindLabels: Record<SubjectKind, string> = {
  farmer: 'Farmer',
  agent: 'Buying agent',
  contact: 'Customer, supplier or donor',
  employee: 'Member of staff',
};

/**
 * The name that replaces a person's own when they are erased. It comes from
 * a random token, never from their name, so nobody can work backwards from
 * it — that is the difference between anonymising and merely hiding.
 */
export function pseudonymFor(kind: SubjectKind, token: string): string {
  return `${subjectKindLabels[kind]} ${token.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase()}`;
}

export type ErasurePlan = {
  /** What will be written over, and with what. */
  replaced: { model: string; field: string; with: string }[];
  /** What will be emptied. */
  removed: { model: string; field: string }[];
  /** What stays, and why. */
  kept: { model: string; field: string; because: string }[];
};

/**
 * What erasing a person actually does. Money is never touched: the amounts,
 * the dates, the journals and the balances all stay exactly as they were,
 * because the law requires the accounts to be kept and an accounting record
 * with a hole in it is not an accounting record.
 */
export function erasurePlan(kind: SubjectKind, pseudonym: string): ErasurePlan {
  const relevant = dataMap.filter((field) => {
    if (kind === 'farmer') return field.subject === 'farmer';
    if (kind === 'agent') return field.subject === 'agent';
    if (kind === 'contact') return field.subject === 'donor-or-supplier';
    return field.subject === 'staff';
  });
  return {
    replaced: relevant.filter((field) => field.onErasure === 'replaced-with-a-pseudonym').map((field) => ({ model: field.model, field: field.field, with: pseudonym })),
    removed: relevant.filter((field) => field.onErasure === 'removed').map((field) => ({ model: field.model, field: field.field })),
    kept: relevant
      .filter((field) => field.onErasure === 'kept')
      .map((field) => ({
        model: field.model,
        field: field.field,
        because: field.sensitivity === 'financial' ? 'It is part of the accounting record, which has to be kept.' : 'It is not enough on its own to identify anybody once the name has gone.',
      })),
  };
}

// --- the report a person is entitled to ------------------------------------------------------------------

export type SubjectRecordGroup = {
  /** Plain words for what this group of records is. */
  title: string;
  /** What it is and why it is held. */
  explanation: string;
  rows: { label: string; value: string }[];
};

export type SubjectReport = {
  subjectKind: SubjectKind;
  subjectLabel: string;
  entityName: string;
  producedAt: string;
  /** What is held about them, in plain words. */
  groups: SubjectRecordGroup[];
  /** What they can ask for next. */
  rights: string[];
};

/** The rights paragraph that goes at the end of every subject access report. */
export const subjectRights: string[] = [
  'You can ask us to correct anything above that is wrong.',
  'You can ask us to erase your personal details. We will replace your name with a reference and delete your telephone number, mobile money number and any signature we hold.',
  'We cannot delete the financial records — what you delivered, what you were paid and when — because Ghanaian law requires us to keep accounting records. After erasure those records remain, but they no longer carry your name.',
  'You can ask who has looked at your details. Every time someone shows a hidden telephone or mobile money number, produces one of these reports, or erases a person, it is recorded and cannot be altered.',
  'If you are not satisfied, you can complain to the Data Protection Commission of Ghana.',
];
