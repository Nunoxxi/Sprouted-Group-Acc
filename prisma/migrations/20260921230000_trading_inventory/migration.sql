-- CreateEnum
CREATE TYPE "CommodityKind" AS ENUM ('CASHEW', 'COCOA', 'OTHER');

-- CreateEnum
CREATE TYPE "LandedCostKind" AS ENUM ('TRANSPORT', 'BAGS', 'LOADING', 'FUMIGATION', 'LEVY', 'COMMISSION');

-- CreateEnum
CREATE TYPE "FloatStatus" AS ENUM ('OPEN', 'RECONCILED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'MOBILE_MONEY');

-- CreateEnum
CREATE TYPE "AgentPurchaseStatus" AS ENUM ('PENDING', 'POSTED', 'REJECTED');

-- AlterEnum
ALTER TYPE "AdjustmentReason" ADD VALUE 'ABNORMAL_LOSS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementKind" ADD VALUE 'LANDED_COST';
ALTER TYPE "StockMovementKind" ADD VALUE 'SHRINKAGE';

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "community" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "landedCostKind" "LandedCostKind",
ADD COLUMN     "lotRef" TEXT,
ADD COLUMN     "qualityJson" TEXT;

-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "floatAgeLimitDays" INTEGER NOT NULL DEFAULT 14;

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "commodityId" TEXT,
ADD COLUMN     "grade" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "lotId" TEXT;

-- CreateTable
CREATE TABLE "Commodity" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CommodityKind" NOT NULL DEFAULT 'OTHER',
    "gramsPerBag" INTEGER NOT NULL,
    "shrinkageTolerancePct" DECIMAL(6,3) NOT NULL DEFAULT 2,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commodity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "commodityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "lotRef" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "supplierContactId" TEXT,
    "farmerName" TEXT,
    "community" TEXT,
    "district" TEXT,
    "kor" DECIMAL(6,2),
    "moisturePct" DECIMAL(5,2),
    "nutCount" INTEGER,
    "cocoaGrade" TEXT,
    "beanCount" INTEGER,
    "gramsIn" BIGINT NOT NULL,
    "gramsShrunk" BIGINT NOT NULL DEFAULT 0,
    "landedCostMinor" BIGINT NOT NULL DEFAULT 0,
    "documentLineId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostAllocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentLineId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "valueMinor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "LandedCostAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyingAgent" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "defaultLocationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyingAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloatAdvance" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "status" "FloatStatus" NOT NULL DEFAULT 'OPEN',
    "journalEntryId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciledById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloatAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloatReturn" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "floatId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloatReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPurchase" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "floatId" TEXT,
    "clientRef" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "farmerName" TEXT NOT NULL,
    "community" TEXT,
    "district" TEXT,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "bags" DECIMAL(10,2),
    "grams" BIGINT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "kor" DECIMAL(6,2),
    "moisturePct" DECIMAL(5,2),
    "nutCount" INTEGER,
    "cocoaGrade" TEXT,
    "beanCount" INTEGER,
    "note" TEXT,
    "status" "AgentPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "lotId" TEXT,
    "journalEntryId" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "AgentPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Commodity_entityId_code_key" ON "Commodity"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_documentLineId_key" ON "Lot"("documentLineId");

-- CreateIndex
CREATE INDEX "Lot_entityId_date_idx" ON "Lot"("entityId", "date");

-- CreateIndex
CREATE INDEX "Lot_entityId_itemId_idx" ON "Lot"("entityId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_entityId_lotRef_key" ON "Lot"("entityId", "lotRef");

-- CreateIndex
CREATE UNIQUE INDEX "LandedCostAllocation_documentLineId_lotId_key" ON "LandedCostAllocation"("documentLineId", "lotId");

-- CreateIndex
CREATE INDEX "BuyingAgent_entityId_idx" ON "BuyingAgent"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "FloatAdvance_journalEntryId_key" ON "FloatAdvance"("journalEntryId");

-- CreateIndex
CREATE INDEX "FloatAdvance_entityId_status_idx" ON "FloatAdvance"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FloatReturn_journalEntryId_key" ON "FloatReturn"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPurchase_lotId_key" ON "AgentPurchase"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPurchase_journalEntryId_key" ON "AgentPurchase"("journalEntryId");

-- CreateIndex
CREATE INDEX "AgentPurchase_entityId_status_idx" ON "AgentPurchase"("entityId", "status");

-- CreateIndex
CREATE INDEX "AgentPurchase_agentId_status_idx" ON "AgentPurchase"("agentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPurchase_entityId_clientRef_key" ON "AgentPurchase"("entityId", "clientRef");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_commodityId_fkey" FOREIGN KEY ("commodityId") REFERENCES "Commodity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commodity" ADD CONSTRAINT "Commodity_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_commodityId_fkey" FOREIGN KEY ("commodityId") REFERENCES "Commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_supplierContactId_fkey" FOREIGN KEY ("supplierContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "DocumentLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "DocumentLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyingAgent" ADD CONSTRAINT "BuyingAgent_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyingAgent" ADD CONSTRAINT "BuyingAgent_defaultLocationId_fkey" FOREIGN KEY ("defaultLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatAdvance" ADD CONSTRAINT "FloatAdvance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatAdvance" ADD CONSTRAINT "FloatAdvance_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "BuyingAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatAdvance" ADD CONSTRAINT "FloatAdvance_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatAdvance" ADD CONSTRAINT "FloatAdvance_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatAdvance" ADD CONSTRAINT "FloatAdvance_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatAdvance" ADD CONSTRAINT "FloatAdvance_reconciledById_fkey" FOREIGN KEY ("reconciledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatReturn" ADD CONSTRAINT "FloatReturn_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatReturn" ADD CONSTRAINT "FloatReturn_floatId_fkey" FOREIGN KEY ("floatId") REFERENCES "FloatAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatReturn" ADD CONSTRAINT "FloatReturn_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatReturn" ADD CONSTRAINT "FloatReturn_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloatReturn" ADD CONSTRAINT "FloatReturn_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "BuyingAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_floatId_fkey" FOREIGN KEY ("floatId") REFERENCES "FloatAdvance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPurchase" ADD CONSTRAINT "AgentPurchase_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

