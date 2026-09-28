-- CreateEnum
CREATE TYPE "LoanFacilityStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "InterestBasis" AS ENUM ('ACTUAL_365', 'ACTUAL_360', 'THIRTY_360');

-- CreateEnum
CREATE TYPE "MoistureMethod" AS ENUM ('WEIGHT_DEDUCTION', 'PRICE_DEDUCTION');

-- CreateEnum
CREATE TYPE "OutturnMethod" AS ENUM ('PROPORTIONAL', 'PER_POINT');

-- CreateEnum
CREATE TYPE "AdvanceStatus" AS ENUM ('OPEN', 'SETTLED', 'WRITTEN_OFF');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "exposureLimitMinor" BIGINT;

-- CreateTable
CREATE TABLE "PreFinanceSetting" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "defaultOutturn" DECIMAL(6,2) NOT NULL DEFAULT 48,
    "defaultMoisturePct" DECIMAL(6,2) NOT NULL DEFAULT 8,
    "defaultMoistureMethod" "MoistureMethod" NOT NULL DEFAULT 'WEIGHT_DEDUCTION',
    "defaultMoisturePctPerPoint" DECIMAL(6,3),
    "defaultOutturnMethod" "OutturnMethod" NOT NULL DEFAULT 'PROPORTIONAL',
    "defaultOutturnMinorPerPoint" BIGINT,
    "defaultOutturnBonus" BOOLEAN,
    "flagAfterDays" INTEGER NOT NULL DEFAULT 14,
    "provisionAfterDays" INTEGER NOT NULL DEFAULT 60,
    "provisionPct" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PreFinanceSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanFacility" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "lenderId" TEXT,
    "reference" TEXT NOT NULL,
    "limitMinor" BIGINT NOT NULL,
    "ratePct" DECIMAL(6,3) NOT NULL,
    "basis" "InterestBasis" NOT NULL DEFAULT 'ACTUAL_365',
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3),
    "status" "LoanFacilityStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanFacility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanTranche" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "drawnOn" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT,
    "repaidOn" TIMESTAMP(3),
    "interestToDate" TIMESTAMP(3),
    "interestMinor" BIGINT NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanTranche_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorAdvance" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "advancedOn" TIMESTAMP(3) NOT NULL,
    "expectedOn" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT,
    "facilityId" TEXT,
    "pricePerKgMinor" BIGINT NOT NULL,
    "outturn" DECIMAL(6,2) NOT NULL,
    "moisturePct" DECIMAL(6,2) NOT NULL,
    "moistureMethod" "MoistureMethod" NOT NULL,
    "moisturePctPerPoint" DECIMAL(6,3),
    "outturnMethod" "OutturnMethod" NOT NULL,
    "outturnMinorPerPoint" BIGINT,
    "outturnBonus" BOOLEAN,
    "status" "AdvanceStatus" NOT NULL DEFAULT 'OPEN',
    "settledOn" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceDelivery" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "deliveredOn" TIMESTAMP(3) NOT NULL,
    "grams" BIGINT NOT NULL,
    "outturn" DECIMAL(6,2) NOT NULL,
    "moisturePct" DECIMAL(6,2) NOT NULL,
    "adjustedGrams" BIGINT NOT NULL,
    "adjustedPricePerKgMinor" BIGINT NOT NULL,
    "valueAtBasisMinor" BIGINT NOT NULL,
    "settledValueMinor" BIGINT NOT NULL,
    "varianceMinor" BIGINT NOT NULL,
    "moistureVarianceMinor" BIGINT NOT NULL,
    "outturnVarianceMinor" BIGINT NOT NULL,
    "stockMovementId" TEXT,
    "journalEntryId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreFinanceCycle" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "facilityId" TEXT,
    "drawnOn" TIMESTAMP(3) NOT NULL,
    "advancedOn" TIMESTAMP(3),
    "deliveredOn" TIMESTAMP(3),
    "processedOn" TIMESTAMP(3),
    "soldOn" TIMESTAMP(3),
    "cashBackOn" TIMESTAMP(3),
    "drawnMinor" BIGINT NOT NULL,
    "advancedMinor" BIGINT NOT NULL DEFAULT 0,
    "proceedsMinor" BIGINT NOT NULL DEFAULT 0,
    "costsMinor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreFinanceCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreFinanceSetting_entityId_key" ON "PreFinanceSetting"("entityId");

-- CreateIndex
CREATE INDEX "LoanFacility_entityId_status_idx" ON "LoanFacility"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LoanFacility_entityId_reference_key" ON "LoanFacility"("entityId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "LoanTranche_journalEntryId_key" ON "LoanTranche"("journalEntryId");

-- CreateIndex
CREATE INDEX "LoanTranche_entityId_facilityId_idx" ON "LoanTranche"("entityId", "facilityId");

-- CreateIndex
CREATE INDEX "LoanTranche_entityId_repaidOn_idx" ON "LoanTranche"("entityId", "repaidOn");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorAdvance_journalEntryId_key" ON "AggregatorAdvance"("journalEntryId");

-- CreateIndex
CREATE INDEX "AggregatorAdvance_entityId_status_expectedOn_idx" ON "AggregatorAdvance"("entityId", "status", "expectedOn");

-- CreateIndex
CREATE INDEX "AggregatorAdvance_entityId_aggregatorId_idx" ON "AggregatorAdvance"("entityId", "aggregatorId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorAdvance_entityId_reference_key" ON "AggregatorAdvance"("entityId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceDelivery_stockMovementId_key" ON "AdvanceDelivery"("stockMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceDelivery_journalEntryId_key" ON "AdvanceDelivery"("journalEntryId");

-- CreateIndex
CREATE INDEX "AdvanceDelivery_entityId_advanceId_idx" ON "AdvanceDelivery"("entityId", "advanceId");

-- CreateIndex
CREATE INDEX "AdvanceDelivery_entityId_deliveredOn_idx" ON "AdvanceDelivery"("entityId", "deliveredOn");

-- CreateIndex
CREATE INDEX "PreFinanceCycle_entityId_cashBackOn_idx" ON "PreFinanceCycle"("entityId", "cashBackOn");

-- CreateIndex
CREATE UNIQUE INDEX "PreFinanceCycle_entityId_reference_key" ON "PreFinanceCycle"("entityId", "reference");

-- AddForeignKey
ALTER TABLE "PreFinanceSetting" ADD CONSTRAINT "PreFinanceSetting_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreFinanceSetting" ADD CONSTRAINT "PreFinanceSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanFacility" ADD CONSTRAINT "LoanFacility_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanFacility" ADD CONSTRAINT "LoanFacility_lenderId_fkey" FOREIGN KEY ("lenderId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanFacility" ADD CONSTRAINT "LoanFacility_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTranche" ADD CONSTRAINT "LoanTranche_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTranche" ADD CONSTRAINT "LoanTranche_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "LoanFacility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTranche" ADD CONSTRAINT "LoanTranche_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTranche" ADD CONSTRAINT "LoanTranche_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTranche" ADD CONSTRAINT "LoanTranche_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorAdvance" ADD CONSTRAINT "AggregatorAdvance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorAdvance" ADD CONSTRAINT "AggregatorAdvance_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorAdvance" ADD CONSTRAINT "AggregatorAdvance_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorAdvance" ADD CONSTRAINT "AggregatorAdvance_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "LoanFacility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorAdvance" ADD CONSTRAINT "AggregatorAdvance_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorAdvance" ADD CONSTRAINT "AggregatorAdvance_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceDelivery" ADD CONSTRAINT "AdvanceDelivery_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceDelivery" ADD CONSTRAINT "AdvanceDelivery_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "AggregatorAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceDelivery" ADD CONSTRAINT "AdvanceDelivery_stockMovementId_fkey" FOREIGN KEY ("stockMovementId") REFERENCES "StockMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceDelivery" ADD CONSTRAINT "AdvanceDelivery_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceDelivery" ADD CONSTRAINT "AdvanceDelivery_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreFinanceCycle" ADD CONSTRAINT "PreFinanceCycle_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreFinanceCycle" ADD CONSTRAINT "PreFinanceCycle_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "LoanFacility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreFinanceCycle" ADD CONSTRAINT "PreFinanceCycle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
