-- Multi-currency: functional currency per entity, transaction currency / amount / rate
-- on every journal line, exchange rates, bank accounts, payments and revaluations.

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('GHS', 'USD', 'EUR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalKind" ADD VALUE 'PAYMENT';
ALTER TYPE "JournalKind" ADD VALUE 'REVALUATION';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'GHS',
ADD COLUMN     "paidTxnMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "rate" DECIMAL(20,10),
ADD COLUMN     "rateDate" TIMESTAMP(3),
ADD COLUMN     "rateExact" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "functionalCurrency" "Currency" NOT NULL DEFAULT 'GHS';

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
ADD COLUMN     "txnAmountMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "txnCurrency" "Currency" NOT NULL DEFAULT 'GHS';

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "base" "Currency" NOT NULL,
    "quote" "Currency" NOT NULL,
    "date" DATE NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "source" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "accountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "txnAmountMinor" BIGINT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "bankAmountMinor" BIGINT NOT NULL,
    "bankFunctionalMinor" BIGINT NOT NULL,
    "reliefMinor" BIGINT NOT NULL,
    "gainLossMinor" BIGINT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revaluation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "closingRatesJson" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "reversalEntryId" TEXT,
    "runById" TEXT,
    "reversedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "Revaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeRate_entityId_date_idx" ON "ExchangeRate"("entityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_entityId_base_quote_date_key" ON "ExchangeRate"("entityId", "base", "quote", "date");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_accountId_key" ON "BankAccount"("accountId");

-- CreateIndex
CREATE INDEX "BankAccount_entityId_idx" ON "BankAccount"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_journalEntryId_key" ON "Payment"("journalEntryId");

-- CreateIndex
CREATE INDEX "Payment_entityId_documentId_idx" ON "Payment"("entityId", "documentId");

-- CreateIndex
CREATE INDEX "Payment_entityId_date_idx" ON "Payment"("entityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Revaluation_journalEntryId_key" ON "Revaluation"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Revaluation_reversalEntryId_key" ON "Revaluation"("reversalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Revaluation_entityId_period_key" ON "Revaluation"("entityId", "period");

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revaluation" ADD CONSTRAINT "Revaluation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revaluation" ADD CONSTRAINT "Revaluation_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revaluation" ADD CONSTRAINT "Revaluation_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revaluation" ADD CONSTRAINT "Revaluation_runById_fkey" FOREIGN KEY ("runById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revaluation" ADD CONSTRAINT "Revaluation_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: everything posted before this migration was in the functional currency
-- (GHS) at a rate of 1. The transaction amount is the functional amount.
UPDATE "JournalLine" SET "txnAmountMinor" = "amountMinor";
UPDATE "Document" SET "rate" = 1, "rateDate" = "date", "rateExact" = true WHERE "status" <> 'DRAFT' AND "rate" IS NULL;
