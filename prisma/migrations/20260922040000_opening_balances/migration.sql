-- CreateEnum
CREATE TYPE "OpeningSection" AS ENUM ('TRIAL_BALANCE', 'INVOICES', 'BILLS', 'STOCK', 'FLOATS', 'FARMER_ADVANCES', 'CONTRACTS');

-- CreateEnum
CREATE TYPE "OpeningBatchStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "FarmerAdvanceStatus" AS ENUM ('OPEN', 'SETTLED');

-- AlterEnum
ALTER TYPE "DeliveryStatus" ADD VALUE 'BEFORE_CUTOVER';

-- AlterEnum
ALTER TYPE "JournalKind" ADD VALUE 'OPENING';

-- DropForeignKey
ALTER TABLE "FloatAdvance" DROP CONSTRAINT "FloatAdvance_bankAccountId_fkey";

-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "cutOverDate" DATE,
ADD COLUMN     "liveAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FloatAdvance" ALTER COLUMN "bankAccountId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "OpeningBatch" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "section" "OpeningSection" NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowsJson" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "status" "OpeningBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmerAdvance" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "farmerName" TEXT NOT NULL,
    "community" TEXT,
    "district" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "settledMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "FarmerAdvanceStatus" NOT NULL DEFAULT 'OPEN',
    "journalEntryId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmerAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpeningBatch_journalEntryId_key" ON "OpeningBatch"("journalEntryId");

-- CreateIndex
CREATE INDEX "OpeningBatch_entityId_section_status_idx" ON "OpeningBatch"("entityId", "section", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FarmerAdvance_journalEntryId_key" ON "FarmerAdvance"("journalEntryId");

-- CreateIndex
CREATE INDEX "FarmerAdvance_entityId_status_idx" ON "FarmerAdvance"("entityId", "status");

-- AddForeignKey
ALTER TABLE "FloatAdvance" ADD CONSTRAINT "FloatAdvance_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBatch" ADD CONSTRAINT "OpeningBatch_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBatch" ADD CONSTRAINT "OpeningBatch_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBatch" ADD CONSTRAINT "OpeningBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerAdvance" ADD CONSTRAINT "FarmerAdvance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerAdvance" ADD CONSTRAINT "FarmerAdvance_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmerAdvance" ADD CONSTRAINT "FarmerAdvance_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

