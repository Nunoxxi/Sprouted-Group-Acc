-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "PayrollLiabilityKind" AS ENUM ('PAYE', 'SSNIT_TIER_1', 'SSNIT_TIER_2', 'NET_PAY', 'OTHER_DEDUCTIONS');

-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "payeDueDay" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "ssnitDueDay" INTEGER NOT NULL DEFAULT 14;

-- CreateTable
CREATE TABLE "PayrollMapping" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "employeeRefColumn" TEXT,
    "employeeNameColumn" TEXT NOT NULL,
    "departmentColumn" TEXT,
    "grossColumn" TEXT NOT NULL,
    "payeColumn" TEXT,
    "employeeSsnitColumn" TEXT,
    "employerSsnitColumn" TEXT,
    "ssnitTier2Column" TEXT,
    "otherDeductionsColumn" TEXT,
    "netColumn" TEXT,
    "defaultAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollDepartment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "payDate" DATE NOT NULL,
    "mappingId" TEXT,
    "fileName" TEXT NOT NULL,
    "grossMinor" BIGINT NOT NULL DEFAULT 0,
    "payeMinor" BIGINT NOT NULL DEFAULT 0,
    "employeeSsnitMinor" BIGINT NOT NULL DEFAULT 0,
    "employerSsnitMinor" BIGINT NOT NULL DEFAULT 0,
    "ssnitTier2Minor" BIGINT NOT NULL DEFAULT 0,
    "otherDeductionsMinor" BIGINT NOT NULL DEFAULT 0,
    "netMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "journalEntryId" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeRef" TEXT,
    "employeeName" TEXT NOT NULL,
    "department" TEXT,
    "grossMinor" BIGINT NOT NULL DEFAULT 0,
    "payeMinor" BIGINT NOT NULL DEFAULT 0,
    "employeeSsnitMinor" BIGINT NOT NULL DEFAULT 0,
    "employerSsnitMinor" BIGINT NOT NULL DEFAULT 0,
    "ssnitTier2Minor" BIGINT NOT NULL DEFAULT 0,
    "otherDeductionsMinor" BIGINT NOT NULL DEFAULT 0,
    "netMinor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "PayrollLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAllocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "employeeKey" TEXT NOT NULL,
    "employeeName" TEXT,
    "grantId" TEXT NOT NULL,
    "budgetLineId" TEXT,
    "pct" DECIMAL(6,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLiability" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "PayrollLiabilityKind" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "settledMinor" BIGINT NOT NULL DEFAULT 0,
    "dueDate" DATE NOT NULL,

    CONSTRAINT "PayrollLiability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLiabilityPayment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "liabilityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "reference" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollLiabilityPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollMapping_entityId_name_key" ON "PayrollMapping"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollDepartment_entityId_name_key" ON "PayrollDepartment"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_journalEntryId_key" ON "PayrollRun"("journalEntryId");

-- CreateIndex
CREATE INDEX "PayrollRun_entityId_status_idx" ON "PayrollRun"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_entityId_period_key" ON "PayrollRun"("entityId", "period");

-- CreateIndex
CREATE INDEX "PayrollLine_entityId_runId_idx" ON "PayrollLine"("entityId", "runId");

-- CreateIndex
CREATE INDEX "PayrollAllocation_entityId_idx" ON "PayrollAllocation"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAllocation_entityId_employeeKey_grantId_key" ON "PayrollAllocation"("entityId", "employeeKey", "grantId");

-- CreateIndex
CREATE INDEX "PayrollLiability_entityId_dueDate_idx" ON "PayrollLiability"("entityId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollLiability_runId_kind_key" ON "PayrollLiability"("runId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollLiabilityPayment_journalEntryId_key" ON "PayrollLiabilityPayment"("journalEntryId");

-- CreateIndex
CREATE INDEX "PayrollLiabilityPayment_entityId_liabilityId_idx" ON "PayrollLiabilityPayment"("entityId", "liabilityId");

-- AddForeignKey
ALTER TABLE "PayrollMapping" ADD CONSTRAINT "PayrollMapping_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollMapping" ADD CONSTRAINT "PayrollMapping_defaultAccountId_fkey" FOREIGN KEY ("defaultAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDepartment" ADD CONSTRAINT "PayrollDepartment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDepartment" ADD CONSTRAINT "PayrollDepartment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "PayrollMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAllocation" ADD CONSTRAINT "PayrollAllocation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAllocation" ADD CONSTRAINT "PayrollAllocation_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "Grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAllocation" ADD CONSTRAINT "PayrollAllocation_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "GrantBudgetLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLiability" ADD CONSTRAINT "PayrollLiability_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLiability" ADD CONSTRAINT "PayrollLiability_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLiabilityPayment" ADD CONSTRAINT "PayrollLiabilityPayment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLiabilityPayment" ADD CONSTRAINT "PayrollLiabilityPayment_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "PayrollLiability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLiabilityPayment" ADD CONSTRAINT "PayrollLiabilityPayment_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLiabilityPayment" ADD CONSTRAINT "PayrollLiabilityPayment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLiabilityPayment" ADD CONSTRAINT "PayrollLiabilityPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

