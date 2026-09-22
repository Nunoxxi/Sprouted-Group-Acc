-- CreateEnum
CREATE TYPE "BankAccountKind" AS ENUM ('BANK', 'MOBILE_MONEY', 'CASH');

-- CreateEnum
CREATE TYPE "PurchaseSettlement" AS ENUM ('FLOAT', 'PAYABLE');

-- CreateEnum
CREATE TYPE "PaymentEvidence" AS ENUM ('SIGNATURE', 'THUMBPRINT', 'REFERENCE');

-- CreateEnum
CREATE TYPE "PaymentBatchStatus" AS ENUM ('DRAFT', 'EXPORTED', 'PAID');

-- CreateEnum
CREATE TYPE "StatementLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'CHARGE');

-- AlterTable
ALTER TABLE "AgentPurchase" ADD COLUMN     "evidenceAt" TIMESTAMP(3),
ADD COLUMN     "evidenceData" TEXT,
ADD COLUMN     "evidenceKind" "PaymentEvidence",
ADD COLUMN     "farmerId" TEXT,
ADD COLUMN     "payableMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "paymentRef" TEXT,
ADD COLUMN     "recoveredMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "settlement" "PurchaseSettlement" NOT NULL DEFAULT 'FLOAT';

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "kind" "BankAccountKind" NOT NULL DEFAULT 'BANK',
ADD COLUMN     "number" TEXT,
ADD COLUMN     "provider" TEXT;

-- AlterTable
ALTER TABLE "FarmerAdvance" ADD COLUMN     "farmerId" TEXT;

-- CreateTable
CREATE TABLE "Farmer" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "community" TEXT,
    "district" TEXT,
    "walletNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Farmer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceRecovery" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmerPaymentBatch" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "status" "PaymentBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "exportedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "settlementJournalEntryId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "paidById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmerPaymentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmerPayment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "farmerId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "walletNumber" TEXT,
    "paymentRef" TEXT,

    CONSTRAINT "FarmerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementMapping" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dateColumn" TEXT NOT NULL,
    "descriptionColumn" TEXT NOT NULL,
    "referenceColumn" TEXT,
    "amountColumn" TEXT,
    "moneyInColumn" TEXT,
    "moneyOutColumn" TEXT,
    "feeColumn" TEXT,
    "levyColumn" TEXT,
    "balanceColumn" TEXT,
    "chargeKeywords" TEXT,
    "dateFormat" TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementImport" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "mappingId" TEXT,
    "fileName" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "lineCount" INTEGER NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "feeJournalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "levyMinor" BIGINT NOT NULL DEFAULT 0,
    "balanceMinor" BIGINT,
    "status" "StatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedBatchId" TEXT,
    "matchedPaymentId" TEXT,
    "journalEntryId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Farmer_entityId_isActive_idx" ON "Farmer"("entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Farmer_entityId_name_key" ON "Farmer"("entityId", "name");

-- CreateIndex
CREATE INDEX "AdvanceRecovery_entityId_idx" ON "AdvanceRecovery"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceRecovery_advanceId_purchaseId_key" ON "AdvanceRecovery"("advanceId", "purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "FarmerPaymentBatch_journalEntryId_key" ON "FarmerPaymentBatch"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "FarmerPaymentBatch_settlementJournalEntryId_key" ON "FarmerPaymentBatch"("settlementJournalEntryId");

-- CreateIndex
CREATE INDEX "FarmerPaymentBatch_entityId_status_idx" ON "FarmerPaymentBatch"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FarmerPaymentBatch_entityId_reference_key" ON "FarmerPaymentBatch"("entityId", "reference");

-- CreateIndex
CREATE INDEX "FarmerPayment_entityId_farmerId_idx" ON "FarmerPayment"("entityId", "farmerId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementMapping_entityId_name_key" ON "StatementMapping"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "StatementImport_feeJournalEntryId_key" ON "StatementImport"("feeJournalEntryId");

-- CreateIndex
CREATE INDEX "StatementImport_entityId_bankAccountId_idx" ON "StatementImport"("entityId", "bankAccountId");

-- CreateIndex
CREATE INDEX "StatementLine_entityId_status_idx" ON "StatementLine"("entityId", "status");

-- CreateIndex
CREATE INDEX "StatementLine_importId_idx" ON "StatementLine"("importId");

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_farmerId_fkey" FOREIGN KEY ("farmerId") REFERENCES "Farmer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerAdvance" ADD CONSTRAINT "FarmerAdvance_farmerId_fkey" FOREIGN KEY ("farmerId") REFERENCES "Farmer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Farmer" ADD CONSTRAINT "Farmer_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRecovery" ADD CONSTRAINT "AdvanceRecovery_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "FarmerAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRecovery" ADD CONSTRAINT "AdvanceRecovery_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "AgentPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPaymentBatch" ADD CONSTRAINT "FarmerPaymentBatch_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPaymentBatch" ADD CONSTRAINT "FarmerPaymentBatch_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPaymentBatch" ADD CONSTRAINT "FarmerPaymentBatch_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPaymentBatch" ADD CONSTRAINT "FarmerPaymentBatch_settlementJournalEntryId_fkey" FOREIGN KEY ("settlementJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPaymentBatch" ADD CONSTRAINT "FarmerPaymentBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPaymentBatch" ADD CONSTRAINT "FarmerPaymentBatch_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPayment" ADD CONSTRAINT "FarmerPayment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPayment" ADD CONSTRAINT "FarmerPayment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FarmerPaymentBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPayment" ADD CONSTRAINT "FarmerPayment_farmerId_fkey" FOREIGN KEY ("farmerId") REFERENCES "Farmer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerPayment" ADD CONSTRAINT "FarmerPayment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "AgentPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementMapping" ADD CONSTRAINT "StatementMapping_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "StatementMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLine" ADD CONSTRAINT "StatementLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLine" ADD CONSTRAINT "StatementLine_importId_fkey" FOREIGN KEY ("importId") REFERENCES "StatementImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLine" ADD CONSTRAINT "StatementLine_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLine" ADD CONSTRAINT "StatementLine_matchedBatchId_fkey" FOREIGN KEY ("matchedBatchId") REFERENCES "FarmerPaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLine" ADD CONSTRAINT "StatementLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

