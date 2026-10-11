-- CreateEnum
CREATE TYPE "PayrollProrationBasis" AS ENUM ('CALENDAR_DAYS', 'WORKING_DAYS');

-- CreateTable
CREATE TABLE "StatutoryRate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "rateBasisPoints" INTEGER,
    "amountMinor" BIGINT,
    "maxCount" INTEGER,
    "choice" TEXT,
    "isPlaceholder" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT,
    "note" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatutoryRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollSetting" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payrollEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payDay" INTEGER NOT NULL DEFAULT 28,
    "tier3Offered" BOOLEAN NOT NULL DEFAULT false,
    "prorationBasis" "PayrollProrationBasis" NOT NULL DEFAULT 'CALENDAR_DAYS',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatutoryRate_key_effectiveFrom_idx" ON "StatutoryRate"("key", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollSetting_entityId_key" ON "PayrollSetting"("entityId");

-- AddForeignKey
ALTER TABLE "PayrollSetting" ADD CONSTRAINT "PayrollSetting_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

