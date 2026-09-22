-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateTable
CREATE TABLE "BuyingSeason" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "commodityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "peakDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "expectedGrams" BIGINT NOT NULL DEFAULT 0,
    "priceMinorPerKg" BIGINT NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL DEFAULT 'GHS',
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyingSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringCost" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'GHS',
    "amountMinor" BIGINT NOT NULL,
    "frequency" "RecurringFrequency" NOT NULL DEFAULT 'MONTHLY',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "accountId" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashScenario" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "collectionDelayDays" INTEGER NOT NULL DEFAULT 0,
    "pricePct" INTEGER NOT NULL DEFAULT 100,
    "volumePct" INTEGER NOT NULL DEFAULT 100,
    "floatLeadDays" INTEGER NOT NULL DEFAULT 7,
    "minimumCashMinor" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashScenarioRate" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,

    CONSTRAINT "CashScenarioRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashScenarioLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'GHS',
    "amountMinor" BIGINT NOT NULL,
    "description" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashScenarioLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuyingSeason_entityId_commodityId_idx" ON "BuyingSeason"("entityId", "commodityId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyingSeason_entityId_name_key" ON "BuyingSeason"("entityId", "name");

-- CreateIndex
CREATE INDEX "RecurringCost_entityId_isActive_idx" ON "RecurringCost"("entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringCost_entityId_name_key" ON "RecurringCost"("entityId", "name");

-- CreateIndex
CREATE INDEX "CashScenario_entityId_isBaseline_idx" ON "CashScenario"("entityId", "isBaseline");

-- CreateIndex
CREATE UNIQUE INDEX "CashScenario_entityId_name_key" ON "CashScenario"("entityId", "name");

-- CreateIndex
CREATE INDEX "CashScenarioRate_entityId_idx" ON "CashScenarioRate"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "CashScenarioRate_scenarioId_currency_key" ON "CashScenarioRate"("scenarioId", "currency");

-- CreateIndex
CREATE INDEX "CashScenarioLine_entityId_scenarioId_idx" ON "CashScenarioLine"("entityId", "scenarioId");

-- AddForeignKey
ALTER TABLE "BuyingSeason" ADD CONSTRAINT "BuyingSeason_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyingSeason" ADD CONSTRAINT "BuyingSeason_commodityId_fkey" FOREIGN KEY ("commodityId") REFERENCES "Commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyingSeason" ADD CONSTRAINT "BuyingSeason_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringCost" ADD CONSTRAINT "RecurringCost_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringCost" ADD CONSTRAINT "RecurringCost_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringCost" ADD CONSTRAINT "RecurringCost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashScenario" ADD CONSTRAINT "CashScenario_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashScenario" ADD CONSTRAINT "CashScenario_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashScenarioRate" ADD CONSTRAINT "CashScenarioRate_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashScenarioRate" ADD CONSTRAINT "CashScenarioRate_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "CashScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashScenarioLine" ADD CONSTRAINT "CashScenarioLine_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashScenarioLine" ADD CONSTRAINT "CashScenarioLine_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "CashScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashScenarioLine" ADD CONSTRAINT "CashScenarioLine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

