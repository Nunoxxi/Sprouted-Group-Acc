-- A draft pay run can be discarded before it is approved. It never reached the
-- ledger, so nothing is reversed; the row is kept, marked discarded and hidden,
-- and the period can be run again.

ALTER TYPE "PayRunStatus" ADD VALUE 'DISCARDED';

ALTER TABLE "PayRun" ADD COLUMN "discardedById" TEXT,
ADD COLUMN "discardedAt" TIMESTAMP(3);
