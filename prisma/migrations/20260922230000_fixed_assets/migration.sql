-- CreateEnum
CREATE TYPE "EntityTaxStatus" AS ENUM ('TAXABLE', 'EXEMPT', 'SPECIAL_RATE');

-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('STRAIGHT_LINE', 'REDUCING_BALANCE');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_USE', 'DISPOSED');

-- CreateEnum
CREATE TYPE "TaxAdjustmentKind" AS ENUM ('ADD_BACK', 'DEDUCTION', 'INCENTIVE');

-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "taxStatus" "EntityTaxStatus" NOT NULL DEFAULT 'TAXABLE';

-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "purchaseDate" DATE NOT NULL,
    "inServiceDate" DATE NOT NULL,
    "costMinor" BIGINT NOT NULL,
    "residualMinor" BIGINT NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "supplierContactId" TEXT,
    "location" TEXT,
    "custodian" TEXT,
    "serialNumber" TEXT,
    "allowanceClassId" TEXT,
    "openingAccumulated" BIGINT NOT NULL DEFAULT 0,
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_USE',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepreciationRun" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepreciationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepreciationLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,

    CONSTRAINT "DepreciationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetDisposal" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "proceedsMinor" BIGINT NOT NULL DEFAULT 0,
    "bankAccountId" TEXT,
    "bookValueMinor" BIGINT NOT NULL,
    "gainLossMinor" BIGINT NOT NULL,
    "note" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetDisposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapitalAllowanceClass" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratePct" DECIMAL(6,3) NOT NULL,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'REDUCING_BALANCE',
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapitalAllowanceClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxYear" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "ratePct" DECIMAL(6,3) NOT NULL,
    "lossBroughtForwardMinor" BIGINT NOT NULL DEFAULT 0,
    "estimatedLiabilityMinor" BIGINT NOT NULL DEFAULT 0,
    "taxChargeMinor" BIGINT,
    "chargeJournalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxYearPool" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxYearId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "openingMinor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "TaxYearPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxAdjustment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxYearId" TEXT NOT NULL,
    "kind" "TaxAdjustmentKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionalTaxPayment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxYearId" TEXT NOT NULL,
    "quarter" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "reference" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvisionalTaxPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixedAsset_entityId_status_idx" ON "FixedAsset"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FixedAsset_entityId_code_key" ON "FixedAsset"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationRun_journalEntryId_key" ON "DepreciationRun"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationRun_entityId_period_key" ON "DepreciationRun"("entityId", "period");

-- CreateIndex
CREATE INDEX "DepreciationLine_entityId_assetId_idx" ON "DepreciationLine"("entityId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationLine_runId_assetId_key" ON "DepreciationLine"("runId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetDisposal_assetId_key" ON "AssetDisposal"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetDisposal_journalEntryId_key" ON "AssetDisposal"("journalEntryId");

-- CreateIndex
CREATE INDEX "AssetDisposal_entityId_date_idx" ON "AssetDisposal"("entityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CapitalAllowanceClass_entityId_code_key" ON "CapitalAllowanceClass"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "TaxYear_chargeJournalEntryId_key" ON "TaxYear"("chargeJournalEntryId");

-- CreateIndex
CREATE INDEX "TaxYear_entityId_startDate_idx" ON "TaxYear"("entityId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "TaxYear_entityId_label_key" ON "TaxYear"("entityId", "label");

-- CreateIndex
CREATE INDEX "TaxYearPool_entityId_idx" ON "TaxYearPool"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxYearPool_taxYearId_classId_key" ON "TaxYearPool"("taxYearId", "classId");

-- CreateIndex
CREATE INDEX "TaxAdjustment_entityId_taxYearId_idx" ON "TaxAdjustment"("entityId", "taxYearId");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisionalTaxPayment_journalEntryId_key" ON "ProvisionalTaxPayment"("journalEntryId");

-- CreateIndex
CREATE INDEX "ProvisionalTaxPayment_entityId_taxYearId_idx" ON "ProvisionalTaxPayment"("entityId", "taxYearId");

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_supplierContactId_fkey" FOREIGN KEY ("supplierContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_allowanceClassId_fkey" FOREIGN KEY ("allowanceClassId") REFERENCES "CapitalAllowanceClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationRun" ADD CONSTRAINT "DepreciationRun_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationRun" ADD CONSTRAINT "DepreciationRun_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationRun" ADD CONSTRAINT "DepreciationRun_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationLine" ADD CONSTRAINT "DepreciationLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DepreciationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationLine" ADD CONSTRAINT "DepreciationLine_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalAllowanceClass" ADD CONSTRAINT "CapitalAllowanceClass_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYear" ADD CONSTRAINT "TaxYear_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYear" ADD CONSTRAINT "TaxYear_chargeJournalEntryId_fkey" FOREIGN KEY ("chargeJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYear" ADD CONSTRAINT "TaxYear_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYearPool" ADD CONSTRAINT "TaxYearPool_taxYearId_fkey" FOREIGN KEY ("taxYearId") REFERENCES "TaxYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYearPool" ADD CONSTRAINT "TaxYearPool_classId_fkey" FOREIGN KEY ("classId") REFERENCES "CapitalAllowanceClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxAdjustment" ADD CONSTRAINT "TaxAdjustment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxAdjustment" ADD CONSTRAINT "TaxAdjustment_taxYearId_fkey" FOREIGN KEY ("taxYearId") REFERENCES "TaxYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionalTaxPayment" ADD CONSTRAINT "ProvisionalTaxPayment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionalTaxPayment" ADD CONSTRAINT "ProvisionalTaxPayment_taxYearId_fkey" FOREIGN KEY ("taxYearId") REFERENCES "TaxYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionalTaxPayment" ADD CONSTRAINT "ProvisionalTaxPayment_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionalTaxPayment" ADD CONSTRAINT "ProvisionalTaxPayment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionalTaxPayment" ADD CONSTRAINT "ProvisionalTaxPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

