-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('PERMANENT', 'CONTRACT', 'CASUAL');

-- CreateEnum
CREATE TYPE "TaxResidency" AS ENUM ('RESIDENT', 'NON_RESIDENT');

-- CreateEnum
CREATE TYPE "EmployeePayMethod" AS ENUM ('BANK', 'MOBILE_MONEY');

-- CreateEnum
CREATE TYPE "PayRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "RemittanceKind" AS ENUM ('PAYE', 'SSNIT_TIER_1', 'SSNIT_TIER_2', 'TIER_3', 'NET_PAY');

-- AlterTable
ALTER TABLE "StatutoryRate" ADD COLUMN     "dayOfMonth" INTEGER;

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "staffNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "tin" TEXT,
    "ssnitNumber" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'PERMANENT',
    "residency" "TaxResidency" NOT NULL DEFAULT 'RESIDENT',
    "department" TEXT,
    "expenseAccountId" TEXT NOT NULL,
    "payMethod" "EmployeePayMethod" NOT NULL DEFAULT 'BANK',
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "momoNumber" TEXT,
    "basicMinor" BIGINT NOT NULL,
    "juniorStaffOvertime" BOOLEAN NOT NULL DEFAULT false,
    "tier3Minor" BIGINT NOT NULL DEFAULT 0,
    "benefitsInKind" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "marriageRelief" BOOLEAN NOT NULL DEFAULT false,
    "childrenInEducation" INTEGER NOT NULL DEFAULT 0,
    "agedDependants" INTEGER NOT NULL DEFAULT 0,
    "disabilityRelief" BOOLEAN NOT NULL DEFAULT false,
    "oldAgeRelief" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAllowance" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "pensionable" BOOLEAN NOT NULL DEFAULT false,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAllocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "shareBasisPoints" INTEGER NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLoan" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'loan',
    "description" TEXT NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "instalmentMinor" BIGINT NOT NULL,
    "issuedOn" DATE NOT NULL,
    "firstPeriod" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRun" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "status" "PayRunStatus" NOT NULL DEFAULT 'DRAFT',
    "payDate" DATE NOT NULL,
    "calculatedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "reversalJournalEntryId" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRunLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "bonusInputMinor" BIGINT NOT NULL DEFAULT 0,
    "overtimeInputMinor" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "inputsJson" TEXT,
    "resultJson" TEXT,
    "daysEmployed" INTEGER NOT NULL DEFAULT 0,
    "basicMinor" BIGINT NOT NULL DEFAULT 0,
    "allowancesMinor" BIGINT NOT NULL DEFAULT 0,
    "nonTaxableMinor" BIGINT NOT NULL DEFAULT 0,
    "bonusMinor" BIGINT NOT NULL DEFAULT 0,
    "overtimeMinor" BIGINT NOT NULL DEFAULT 0,
    "grossMinor" BIGINT NOT NULL DEFAULT 0,
    "ssnitBaseMinor" BIGINT NOT NULL DEFAULT 0,
    "employeeSsnitMinor" BIGINT NOT NULL DEFAULT 0,
    "tier3Minor" BIGINT NOT NULL DEFAULT 0,
    "benefitsMinor" BIGINT NOT NULL DEFAULT 0,
    "reliefsMinor" BIGINT NOT NULL DEFAULT 0,
    "chargeableMinor" BIGINT NOT NULL DEFAULT 0,
    "payeMinor" BIGINT NOT NULL DEFAULT 0,
    "bonusTaxMinor" BIGINT NOT NULL DEFAULT 0,
    "overtimeTaxMinor" BIGINT NOT NULL DEFAULT 0,
    "bonusConcessionMinor" BIGINT NOT NULL DEFAULT 0,
    "deductionsMinor" BIGINT NOT NULL DEFAULT 0,
    "netMinor" BIGINT NOT NULL DEFAULT 0,
    "employerSsnitMinor" BIGINT NOT NULL DEFAULT 0,
    "employerTier2Minor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "PayRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRunDeduction" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "loanId" TEXT,
    "name" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,

    CONSTRAINT "PayRunDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRemittance" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "RemittanceKind" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "dueDate" DATE NOT NULL,
    "paidOn" DATE,
    "reference" TEXT,
    "bankAccountId" TEXT,
    "journalEntryId" TEXT,
    "paidById" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PayrollRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloatLabourPayment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "floatId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "workers" INTEGER,
    "amountMinor" BIGINT NOT NULL,
    "accountId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloatLabourPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employee_entityId_idx" ON "Employee"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_entityId_staffNumber_key" ON "Employee"("entityId", "staffNumber");

-- CreateIndex
CREATE INDEX "EmployeeAllowance_entityId_employeeId_idx" ON "EmployeeAllowance"("entityId", "employeeId");

-- CreateIndex
CREATE INDEX "EmployeeAllocation_entityId_employeeId_idx" ON "EmployeeAllocation"("entityId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffLoan_journalEntryId_key" ON "StaffLoan"("journalEntryId");

-- CreateIndex
CREATE INDEX "StaffLoan_entityId_employeeId_idx" ON "StaffLoan"("entityId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayRun_journalEntryId_key" ON "PayRun"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "PayRun_reversalJournalEntryId_key" ON "PayRun"("reversalJournalEntryId");

-- CreateIndex
CREATE INDEX "PayRun_entityId_status_idx" ON "PayRun"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayRun_entityId_period_sequence_key" ON "PayRun"("entityId", "period", "sequence");

-- CreateIndex
CREATE INDEX "PayRunLine_entityId_employeeId_idx" ON "PayRunLine"("entityId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayRunLine_runId_employeeId_key" ON "PayRunLine"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "PayRunDeduction_entityId_loanId_idx" ON "PayRunDeduction"("entityId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRemittance_journalEntryId_key" ON "PayrollRemittance"("journalEntryId");

-- CreateIndex
CREATE INDEX "PayrollRemittance_entityId_dueDate_idx" ON "PayrollRemittance"("entityId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRemittance_runId_kind_key" ON "PayrollRemittance"("runId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "FloatLabourPayment_journalEntryId_key" ON "FloatLabourPayment"("journalEntryId");

-- CreateIndex
CREATE INDEX "FloatLabourPayment_entityId_date_idx" ON "FloatLabourPayment"("entityId", "date");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAllowance" ADD CONSTRAINT "EmployeeAllowance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAllowance" ADD CONSTRAINT "EmployeeAllowance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAllocation" ADD CONSTRAINT "EmployeeAllocation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAllocation" ADD CONSTRAINT "EmployeeAllocation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAllocation" ADD CONSTRAINT "EmployeeAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLoan" ADD CONSTRAINT "StaffLoan_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLoan" ADD CONSTRAINT "StaffLoan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLoan" ADD CONSTRAINT "StaffLoan_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLoan" ADD CONSTRAINT "StaffLoan_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_reversalJournalEntryId_fkey" FOREIGN KEY ("reversalJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLine" ADD CONSTRAINT "PayRunLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLine" ADD CONSTRAINT "PayRunLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLine" ADD CONSTRAINT "PayRunLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunDeduction" ADD CONSTRAINT "PayRunDeduction_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunDeduction" ADD CONSTRAINT "PayRunDeduction_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "PayRunLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunDeduction" ADD CONSTRAINT "PayRunDeduction_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "StaffLoan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRemittance" ADD CONSTRAINT "PayrollRemittance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRemittance" ADD CONSTRAINT "PayrollRemittance_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRemittance" ADD CONSTRAINT "PayrollRemittance_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRemittance" ADD CONSTRAINT "PayrollRemittance_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatLabourPayment" ADD CONSTRAINT "FloatLabourPayment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatLabourPayment" ADD CONSTRAINT "FloatLabourPayment_floatId_fkey" FOREIGN KEY ("floatId") REFERENCES "FloatAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatLabourPayment" ADD CONSTRAINT "FloatLabourPayment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "BuyingAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatLabourPayment" ADD CONSTRAINT "FloatLabourPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatLabourPayment" ADD CONSTRAINT "FloatLabourPayment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

