-- CreateEnum
CREATE TYPE "GrantStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "GrantIncomePolicy" AS ENUM ('ON_RECEIPT', 'DEFERRED');

-- CreateEnum
CREATE TYPE "GrantReportingFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL', 'FINAL_ONLY');

-- CreateEnum
CREATE TYPE "GrantReleaseBasis" AS ENUM ('SPENDING', 'CONDITION');

-- CreateEnum
CREATE TYPE "InKindKind" AS ENUM ('GOODS', 'SERVICES', 'FACILITIES');

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "budgetLineId" TEXT,
ADD COLUMN     "grantId" TEXT;

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "budgetLineId" TEXT,
ADD COLUMN     "grantId" TEXT;

-- CreateTable
CREATE TABLE "Grant" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "donorContactId" TEXT NOT NULL,
    "fundId" TEXT,
    "projectId" TEXT,
    "currency" "Currency" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT true,
    "incomePolicy" "GrantIncomePolicy" NOT NULL DEFAULT 'ON_RECEIPT',
    "reportingFrequency" "GrantReportingFrequency" NOT NULL DEFAULT 'QUARTERLY',
    "reportingStartDate" DATE,
    "reportingDueDays" INTEGER NOT NULL DEFAULT 30,
    "underspendThresholdPct" INTEGER NOT NULL DEFAULT 75,
    "status" "GrantStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrantBudgetLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "budgetMinor" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrantBudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrantCondition" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dueDate" DATE,
    "metAt" TIMESTAMP(3),
    "metById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrantCondition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrantReceipt" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "txnCurrency" "Currency" NOT NULL,
    "txnAmountMinor" BIGINT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "reference" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrantReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrantRelease" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "basis" "GrantReleaseBasis" NOT NULL,
    "conditionId" TEXT,
    "note" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrantRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InKindContribution" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "grantId" TEXT,
    "budgetLineId" TEXT,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "InKindKind" NOT NULL DEFAULT 'GOODS',
    "valueMinor" BIGINT NOT NULL,
    "basis" TEXT,
    "donorContactId" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InKindContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffTimeAllocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "budgetLineId" TEXT,
    "personName" TEXT NOT NULL,
    "role" TEXT,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "hours" DECIMAL(10,2) NOT NULL,
    "rateMinorPerHour" BIGINT NOT NULL,
    "valueMinor" BIGINT NOT NULL,
    "accountId" TEXT NOT NULL,
    "note" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffTimeAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Grant_entityId_status_idx" ON "Grant"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Grant_entityId_code_key" ON "Grant"("entityId", "code");

-- CreateIndex
CREATE INDEX "GrantBudgetLine_entityId_grantId_idx" ON "GrantBudgetLine"("entityId", "grantId");

-- CreateIndex
CREATE UNIQUE INDEX "GrantBudgetLine_grantId_code_key" ON "GrantBudgetLine"("grantId", "code");

-- CreateIndex
CREATE INDEX "GrantCondition_entityId_grantId_idx" ON "GrantCondition"("entityId", "grantId");

-- CreateIndex
CREATE UNIQUE INDEX "GrantReceipt_journalEntryId_key" ON "GrantReceipt"("journalEntryId");

-- CreateIndex
CREATE INDEX "GrantReceipt_entityId_grantId_idx" ON "GrantReceipt"("entityId", "grantId");

-- CreateIndex
CREATE UNIQUE INDEX "GrantRelease_journalEntryId_key" ON "GrantRelease"("journalEntryId");

-- CreateIndex
CREATE INDEX "GrantRelease_entityId_grantId_idx" ON "GrantRelease"("entityId", "grantId");

-- CreateIndex
CREATE UNIQUE INDEX "InKindContribution_journalEntryId_key" ON "InKindContribution"("journalEntryId");

-- CreateIndex
CREATE INDEX "InKindContribution_entityId_grantId_idx" ON "InKindContribution"("entityId", "grantId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffTimeAllocation_journalEntryId_key" ON "StaffTimeAllocation"("journalEntryId");

-- CreateIndex
CREATE INDEX "StaffTimeAllocation_entityId_grantId_idx" ON "StaffTimeAllocation"("entityId", "grantId");

-- CreateIndex
CREATE INDEX "JournalLine_entityId_grantId_idx" ON "JournalLine"("entityId", "grantId");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "GrantBudgetLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "GrantBudgetLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grant" ADD CONSTRAINT "Grant_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grant" ADD CONSTRAINT "Grant_donorContactId_fkey" FOREIGN KEY ("donorContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grant" ADD CONSTRAINT "Grant_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grant" ADD CONSTRAINT "Grant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grant" ADD CONSTRAINT "Grant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantBudgetLine" ADD CONSTRAINT "GrantBudgetLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantBudgetLine" ADD CONSTRAINT "GrantBudgetLine_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantBudgetLine" ADD CONSTRAINT "GrantBudgetLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantCondition" ADD CONSTRAINT "GrantCondition_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantCondition" ADD CONSTRAINT "GrantCondition_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantCondition" ADD CONSTRAINT "GrantCondition_metById_fkey" FOREIGN KEY ("metById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantReceipt" ADD CONSTRAINT "GrantReceipt_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantReceipt" ADD CONSTRAINT "GrantReceipt_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantReceipt" ADD CONSTRAINT "GrantReceipt_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantReceipt" ADD CONSTRAINT "GrantReceipt_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantReceipt" ADD CONSTRAINT "GrantReceipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantRelease" ADD CONSTRAINT "GrantRelease_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantRelease" ADD CONSTRAINT "GrantRelease_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantRelease" ADD CONSTRAINT "GrantRelease_conditionId_fkey" FOREIGN KEY ("conditionId") REFERENCES "GrantCondition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantRelease" ADD CONSTRAINT "GrantRelease_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrantRelease" ADD CONSTRAINT "GrantRelease_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InKindContribution" ADD CONSTRAINT "InKindContribution_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InKindContribution" ADD CONSTRAINT "InKindContribution_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InKindContribution" ADD CONSTRAINT "InKindContribution_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "GrantBudgetLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InKindContribution" ADD CONSTRAINT "InKindContribution_donorContactId_fkey" FOREIGN KEY ("donorContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InKindContribution" ADD CONSTRAINT "InKindContribution_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InKindContribution" ADD CONSTRAINT "InKindContribution_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTimeAllocation" ADD CONSTRAINT "StaffTimeAllocation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTimeAllocation" ADD CONSTRAINT "StaffTimeAllocation_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTimeAllocation" ADD CONSTRAINT "StaffTimeAllocation_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "GrantBudgetLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTimeAllocation" ADD CONSTRAINT "StaffTimeAllocation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTimeAllocation" ADD CONSTRAINT "StaffTimeAllocation_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTimeAllocation" ADD CONSTRAINT "StaffTimeAllocation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

