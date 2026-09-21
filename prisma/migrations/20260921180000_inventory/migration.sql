-- CreateEnum
CREATE TYPE "ItemCategory" AS ENUM ('RAW_MATERIAL', 'PACKAGING', 'WORK_IN_PROGRESS', 'FINISHED_GOOD', 'BY_PRODUCT');

-- CreateEnum
CREATE TYPE "StockUnit" AS ENUM ('KG', 'BAG', 'CARTON', 'TONNE');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('RECEIPT', 'RECEIPT_REVERSAL', 'TRANSFER', 'ADJUSTMENT', 'WRITE_DOWN');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('COUNT_DIFFERENCE', 'MOISTURE_LOSS', 'DAMAGE', 'SPOILAGE', 'NRV_WRITE_DOWN');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'POSTED');

-- AlterEnum
ALTER TYPE "JournalKind" ADD VALUE 'STOCK';

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "itemId" TEXT,
ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ItemCategory" NOT NULL,
    "baseUnit" "StockUnit" NOT NULL DEFAULT 'KG',
    "gramsPerBag" INTEGER,
    "gramsPerCarton" INTEGER,
    "accountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantityGrams" BIGINT NOT NULL DEFAULT 0,
    "valueMinor" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "itemId" TEXT NOT NULL,
    "fromLocationId" TEXT,
    "toLocationId" TEXT,
    "quantityGrams" BIGINT NOT NULL,
    "valueMinor" BIGINT NOT NULL,
    "reason" "AdjustmentReason",
    "note" TEXT,
    "documentId" TEXT,
    "documentLineId" TEXT,
    "stockCountId" TEXT,
    "journalEntryId" TEXT,
    "reversesId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "stockCountId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "expectedGrams" BIGINT NOT NULL,
    "countedGrams" BIGINT,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NrvPrice" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "sellingPriceMinorPerKg" BIGINT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NrvPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Item_entityId_category_idx" ON "Item"("entityId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Item_entityId_code_key" ON "Item"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_entityId_code_key" ON "StockLocation"("entityId", "code");

-- CreateIndex
CREATE INDEX "StockBalance_entityId_idx" ON "StockBalance"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_itemId_locationId_key" ON "StockBalance"("itemId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_reversesId_key" ON "StockMovement"("reversesId");

-- CreateIndex
CREATE INDEX "StockMovement_entityId_date_idx" ON "StockMovement"("entityId", "date");

-- CreateIndex
CREATE INDEX "StockMovement_entityId_itemId_idx" ON "StockMovement"("entityId", "itemId");

-- CreateIndex
CREATE INDEX "StockMovement_documentId_idx" ON "StockMovement"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_journalEntryId_key" ON "StockCount"("journalEntryId");

-- CreateIndex
CREATE INDEX "StockCount_entityId_status_idx" ON "StockCount"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_stockCountId_itemId_key" ON "StockCountLine"("stockCountId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "NrvPrice_entityId_itemId_period_key" ON "NrvPrice"("entityId", "itemId", "period");

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "DocumentLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "StockMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NrvPrice" ADD CONSTRAINT "NrvPrice_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NrvPrice" ADD CONSTRAINT "NrvPrice_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NrvPrice" ADD CONSTRAINT "NrvPrice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

