/**
 * The shell's lowercase enum strings ↔ Prisma's uppercase enums.
 *
 * Deliberately free of runtime imports so the seed script can load it under
 * plain Node (which resolves relative imports strictly). Type imports are
 * erased and do not count.
 */

import type {
  ContactCategory as PrismaContactCategory,
  ContactType as PrismaContactType,
  FundClassification as PrismaFundClassification,
  WithholdingTaxStatus as PrismaWithholdingTaxStatus,
} from '@prisma/client';

import type { WithholdingTaxStatus } from '../ghana-tax';

export type { WithholdingTaxStatus };
export type ContactType = 'customer' | 'supplier' | 'both';
export type ContactCategory = 'customer' | 'supplier' | 'farmer' | 'group-entity' | 'other';
export type FundClassification = 'restricted' | 'unrestricted';

export const contactTypeToRecord: Record<PrismaContactType, ContactType> = {
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  BOTH: 'both',
};
export const contactTypeToPrisma: Record<ContactType, PrismaContactType> = {
  customer: 'CUSTOMER',
  supplier: 'SUPPLIER',
  both: 'BOTH',
};

export const contactCategoryToRecord: Record<PrismaContactCategory, ContactCategory> = {
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  FARMER: 'farmer',
  GROUP_ENTITY: 'group-entity',
  OTHER: 'other',
};
export const contactCategoryToPrisma: Record<ContactCategory, PrismaContactCategory> = {
  customer: 'CUSTOMER',
  supplier: 'SUPPLIER',
  farmer: 'FARMER',
  'group-entity': 'GROUP_ENTITY',
  other: 'OTHER',
};

export const whtToRecord: Record<PrismaWithholdingTaxStatus, WithholdingTaxStatus> = {
  NONE: 'none',
  WHT_5: '5%',
  WHT_10: '10%',
  EXEMPT: 'exempt',
};
export const whtToPrisma: Record<WithholdingTaxStatus, PrismaWithholdingTaxStatus> = {
  none: 'NONE',
  '5%': 'WHT_5',
  '10%': 'WHT_10',
  exempt: 'EXEMPT',
};

export const fundClassToRecord: Record<PrismaFundClassification, FundClassification> = {
  RESTRICTED: 'restricted',
  UNRESTRICTED: 'unrestricted',
};
export const fundClassToPrisma: Record<FundClassification, PrismaFundClassification> = {
  restricted: 'RESTRICTED',
  unrestricted: 'UNRESTRICTED',
};
