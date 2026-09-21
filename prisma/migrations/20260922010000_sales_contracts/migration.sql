-- CreateEnum
CREATE TYPE "RevenuePresentation" AS ENUM ('GROSS', 'NET');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RevenueRecognition" AS ENUM ('DELIVERY', 'ACCEPTANCE');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('DELIVERED', 'AWAITING_ACCEPTANCE', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "SellingCostKind" AS ENUM ('TRANSPORT_TO_BUYER', 'PORT_HANDLING', 'EXPORT_PERMIT', 'LEVY', 'OTHER');

-- CreateEnum
CREATE TYPE "SeedFundKind" AS ENUM ('RECEIVED', 'REPAID', 'OFFSET');

-- AlterEnum
ALTER TYPE "StockMovementKind" ADD VALUE 'DELIVERY';

-- AlterEnum
ALTER TYPE "JournalKind" ADD VALUE 'CONTRACT';

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "sellingCostKind" "SellingCostKind";

-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "buyerMarginMinorPerKg" BIGINT,
ADD COLUMN     "haulageMinorPerKg" BIGINT,
ADD COLUMN     "lbcMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "producerPriceMinorPerKg" BIGINT,
ADD COLUMN     "revenuePresentation" "RevenuePresentation" NOT NULL DEFAULT 'GROSS';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "deliveryId" TEXT;

-- CreateTable
CREATE TABLE "SalesContract" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "contractNo" TEXT NOT NULL,
    "buyerContactId" TEXT NOT NULL,
    "commodityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantityGrams" BIGINT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "priceUnit" "StockUnit" NOT NULL DEFAULT 'KG',
    "currency" "Currency" NOT NULL DEFAULT 'GHS',
    "contractRate" DECIMAL(20,10),
    "deliveryTerms" TEXT NOT NULL,
    "deliveryFrom" TIMESTAMP(3) NOT NULL,
    "deliveryTo" TIMESTAMP(3) NOT NULL,
    "recognizeOn" "RevenueRecognition" NOT NULL DEFAULT 'DELIVERY',
    "saleType" "SaleType" NOT NULL DEFAULT 'DOMESTIC',
    "isCmc" BOOLEAN NOT NULL DEFAULT false,
    "status" "ContractStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractDelivery" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "deliveryNo" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "locationId" TEXT NOT NULL,
    "grams" BIGINT NOT NULL,
    "destination" TEXT,
    "rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
    "revenueTxnMinor" BIGINT NOT NULL,
    "revenueMinor" BIGINT NOT NULL,
    "costMinor" BIGINT NOT NULL,
    "marginMinor" BIGINT NOT NULL DEFAULT 0,
    "haulageMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'DELIVERED',
    "journalEntryId" TEXT,
    "acceptanceJournalEntryId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractSellingCost" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "kind" "SellingCostKind" NOT NULL,
    "description" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "documentLineId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractSellingCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedFundMovement" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "SeedFundKind" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bankAccountId" TEXT,
    "journalEntryId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeedFundMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesContract_entityId_status_idx" ON "SalesContract"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SalesContract_entityId_contractNo_key" ON "SalesContract"("entityId", "contractNo");

-- CreateIndex
CREATE UNIQUE INDEX "ContractDelivery_journalEntryId_key" ON "ContractDelivery"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractDelivery_acceptanceJournalEntryId_key" ON "ContractDelivery"("acceptanceJournalEntryId");

-- CreateIndex
CREATE INDEX "ContractDelivery_entityId_date_idx" ON "ContractDelivery"("entityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ContractDelivery_contractId_deliveryNo_key" ON "ContractDelivery"("contractId", "deliveryNo");

-- CreateIndex
CREATE UNIQUE INDEX "ContractSellingCost_documentLineId_key" ON "ContractSellingCost"("documentLineId");

-- CreateIndex
CREATE INDEX "ContractSellingCost_contractId_idx" ON "ContractSellingCost"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedFundMovement_journalEntryId_key" ON "SeedFundMovement"("journalEntryId");

-- CreateIndex
CREATE INDEX "SeedFundMovement_entityId_date_idx" ON "SeedFundMovement"("entityId", "date");

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SalesContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "ContractDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesContract" ADD CONSTRAINT "SalesContract_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesContract" ADD CONSTRAINT "SalesContract_buyerContactId_fkey" FOREIGN KEY ("buyerContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesContract" ADD CONSTRAINT "SalesContract_commodityId_fkey" FOREIGN KEY ("commodityId") REFERENCES "Commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesContract" ADD CONSTRAINT "SalesContract_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesContract" ADD CONSTRAINT "SalesContract_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDelivery" ADD CONSTRAINT "ContractDelivery_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDelivery" ADD CONSTRAINT "ContractDelivery_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SalesContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDelivery" ADD CONSTRAINT "ContractDelivery_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDelivery" ADD CONSTRAINT "ContractDelivery_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDelivery" ADD CONSTRAINT "ContractDelivery_acceptanceJournalEntryId_fkey" FOREIGN KEY ("acceptanceJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDelivery" ADD CONSTRAINT "ContractDelivery_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDelivery" ADD CONSTRAINT "ContractDelivery_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractSellingCost" ADD CONSTRAINT "ContractSellingCost_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractSellingCost" ADD CONSTRAINT "ContractSellingCost_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SalesContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractSellingCost" ADD CONSTRAINT "ContractSellingCost_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "DocumentLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedFundMovement" ADD CONSTRAINT "SeedFundMovement_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedFundMovement" ADD CONSTRAINT "SeedFundMovement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedFundMovement" ADD CONSTRAINT "SeedFundMovement_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedFundMovement" ADD CONSTRAINT "SeedFundMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

