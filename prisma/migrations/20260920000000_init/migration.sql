-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "ContactCategory" AS ENUM ('CUSTOMER', 'SUPPLIER', 'FARMER', 'GROUP_ENTITY', 'OTHER');

-- CreateEnum
CREATE TYPE "WithholdingTaxStatus" AS ENUM ('NONE', 'WHT_5', 'WHT_10', 'EXEMPT');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'EXPENSE');

-- CreateEnum
CREATE TYPE "JournalKind" AS ENUM ('DOCUMENT', 'REVERSAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "FundClassification" AS ENUM ('RESTRICTED', 'UNRESTRICTED');

-- CreateEnum
CREATE TYPE "JournalDirection" AS ENUM ('MONEY_IN', 'MONEY_OUT');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('INVOICE', 'BILL');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'AWAITING_PAYMENT', 'PAID', 'VOIDED');

-- CreateEnum
CREATE TYPE "VatTreatment" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "financialYearEnd" TEXT,
    "vatRegistered" BOOLEAN NOT NULL DEFAULT false,
    "tin" TEXT,
    "accent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "userName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceRef" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metadataJson" TEXT,
    "hash" TEXT NOT NULL,
    "previousHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'export',
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ContactType" NOT NULL,
    "category" "ContactCategory" NOT NULL DEFAULT 'OTHER',
    "tin" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "withholdingTaxStatus" "WithholdingTaxStatus" NOT NULL DEFAULT 'NONE',
    "isFarmerAggregator" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactEntityBalance" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactEntityBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "parentId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "JournalKind" NOT NULL DEFAULT 'MANUAL',
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fundId" TEXT,
    "projectId" TEXT,
    "contactId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "direction" "JournalDirection" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fund" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "classification" "FundClassification" NOT NULL,
    "funder" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fundId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "funder" TEXT,
    "budgetMinor" BIGINT NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "number" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "evatClearanceNumber" TEXT,
    "evatQrCode" TEXT,
    "evatTimestamp" TEXT,
    "journalEntryId" TEXT,
    "voidEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vatTreatment" "VatTreatment" NOT NULL DEFAULT 'STANDARD',
    "projectId" TEXT,
    "fundId" TEXT,

    CONSTRAINT "DocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxPeriodFiling" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filedBy" TEXT NOT NULL,

    CONSTRAINT "TaxPeriodFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCounter" (
    "entityId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("entityId","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "Entity_code_key" ON "Entity"("code");

-- CreateIndex
CREATE INDEX "AuditEvent_entityId_resourceType_idx" ON "AuditEvent"("entityId", "resourceType");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_entityId_sequence_key" ON "AuditEvent"("entityId", "sequence");

-- CreateIndex
CREATE INDEX "BackupRun_entityId_createdAt_idx" ON "BackupRun"("entityId", "createdAt");

-- CreateIndex
CREATE INDEX "BackupRun_createdAt_idx" ON "BackupRun"("createdAt");

-- CreateIndex
CREATE INDEX "ContactEntityBalance_entityId_balanceMinor_idx" ON "ContactEntityBalance"("entityId", "balanceMinor");

-- CreateIndex
CREATE UNIQUE INDEX "ContactEntityBalance_contactId_entityId_key" ON "ContactEntityBalance"("contactId", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_entityId_parentId_idx" ON "Account"("entityId", "parentId");

-- CreateIndex
CREATE INDEX "Account_entityId_type_idx" ON "Account"("entityId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Account_entityId_code_key" ON "Account"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntry_entityId_postedAt_idx" ON "JournalEntry"("entityId", "postedAt");

-- CreateIndex
CREATE INDEX "JournalEntry_entityId_kind_idx" ON "JournalEntry"("entityId", "kind");

-- CreateIndex
CREATE INDEX "JournalLine_entityId_journalEntryId_idx" ON "JournalLine"("entityId", "journalEntryId");

-- CreateIndex
CREATE INDEX "JournalLine_entityId_accountId_idx" ON "JournalLine"("entityId", "accountId");

-- CreateIndex
CREATE INDEX "JournalLine_entityId_fundId_idx" ON "JournalLine"("entityId", "fundId");

-- CreateIndex
CREATE INDEX "JournalLine_entityId_projectId_idx" ON "JournalLine"("entityId", "projectId");

-- CreateIndex
CREATE INDEX "JournalLine_entityId_contactId_idx" ON "JournalLine"("entityId", "contactId");

-- CreateIndex
CREATE INDEX "Fund_entityId_classification_idx" ON "Fund"("entityId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "Fund_entityId_code_key" ON "Fund"("entityId", "code");

-- CreateIndex
CREATE INDEX "Project_entityId_fundId_idx" ON "Project"("entityId", "fundId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_entityId_code_key" ON "Project"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Document_journalEntryId_key" ON "Document"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_voidEntryId_key" ON "Document"("voidEntryId");

-- CreateIndex
CREATE INDEX "Document_entityId_status_idx" ON "Document"("entityId", "status");

-- CreateIndex
CREATE INDEX "Document_entityId_date_idx" ON "Document"("entityId", "date");

-- CreateIndex
CREATE INDEX "Document_entityId_contactId_idx" ON "Document"("entityId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_entityId_number_key" ON "Document"("entityId", "number");

-- CreateIndex
CREATE INDEX "DocumentLine_documentId_position_idx" ON "DocumentLine"("documentId", "position");

-- CreateIndex
CREATE INDEX "DocumentLine_entityId_accountId_idx" ON "DocumentLine"("entityId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxPeriodFiling_entityId_period_key" ON "TaxPeriodFiling"("entityId", "period");

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRun" ADD CONSTRAINT "BackupRun_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEntityBalance" ADD CONSTRAINT "ContactEntityBalance_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEntityBalance" ADD CONSTRAINT "ContactEntityBalance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fund" ADD CONSTRAINT "Fund_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_voidEntryId_fkey" FOREIGN KEY ("voidEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxPeriodFiling" ADD CONSTRAINT "TaxPeriodFiling_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCounter" ADD CONSTRAINT "DocumentCounter_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

