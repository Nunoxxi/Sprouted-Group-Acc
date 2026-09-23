-- CreateEnum
CREATE TYPE "ProjectKind" AS ENUM ('GRANT_FUNDED', 'SERVICE_CONTRACT');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'GHS',
ADD COLUMN     "endDate" DATE,
ADD COLUMN     "funderContactId" TEXT,
ADD COLUMN     "fundingMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "kind" "ProjectKind" NOT NULL DEFAULT 'GRANT_FUNDED',
ADD COLUMN     "startDate" DATE;

-- CreateTable
CREATE TABLE "ProjectBudgetLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT,
    "originalMinor" BIGINT NOT NULL DEFAULT 0,
    "revisedMinor" BIGINT,
    "revisedAt" TIMESTAMP(3),
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectBudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetCategory" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratePct" DECIMAL(6,3) NOT NULL,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "accountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRateSetting" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "vatPct" DECIMAL(6,3) NOT NULL DEFAULT 15,
    "nhilPct" DECIMAL(6,3) NOT NULL DEFAULT 2.5,
    "getFundPct" DECIMAL(6,3) NOT NULL DEFAULT 2.5,
    "registrationThresholdMinor" BIGINT NOT NULL DEFAULT 75000000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRateSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectBudgetLine_entityId_projectId_idx" ON "ProjectBudgetLine"("entityId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetCategory_entityId_name_key" ON "AssetCategory"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRateSetting_entityId_key" ON "TaxRateSetting"("entityId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_funderContactId_fkey" FOREIGN KEY ("funderContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBudgetLine" ADD CONSTRAINT "ProjectBudgetLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBudgetLine" ADD CONSTRAINT "ProjectBudgetLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBudgetLine" ADD CONSTRAINT "ProjectBudgetLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRateSetting" ADD CONSTRAINT "TaxRateSetting_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

