-- DEFERRED: drop the retired payroll import. NOT YET A MIGRATION.
--
-- This removes the tables the old payroll import used (no rows in production:
-- checked 2026-10-11, PayrollRun 0, unpaid PayrollLiability 0) and the two
-- per-entity due-day columns it read, now replaced by the dated deadline
-- rules in StatutoryRate.
--
-- It is deliberately kept out of prisma/migrations. The code that stops
-- reading these tables has to be live in production first: Render runs
-- `prisma migrate deploy` while the previous release is still serving, and
-- that release reads PayrollRun on every page load. Dropping in the same
-- deploy is the failure src/lib/migration-safety.ts exists to prevent.
--
-- When the release without the payroll import is deployed and healthy:
--   1. move this file to prisma/migrations/<timestamp>_drop_payroll_import/migration.sql
--   2. apply it to dev (npm run prisma:deploy — db-guard will flag it as
--      destructive, which is expected), then commit and deploy on its own.
-- DropForeignKey
ALTER TABLE "PayrollAllocation" DROP CONSTRAINT "PayrollAllocation_budgetLineId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollAllocation" DROP CONSTRAINT "PayrollAllocation_entityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollAllocation" DROP CONSTRAINT "PayrollAllocation_grantId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollDepartment" DROP CONSTRAINT "PayrollDepartment_accountId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollDepartment" DROP CONSTRAINT "PayrollDepartment_entityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLiability" DROP CONSTRAINT "PayrollLiability_entityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLiability" DROP CONSTRAINT "PayrollLiability_runId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLiabilityPayment" DROP CONSTRAINT "PayrollLiabilityPayment_bankAccountId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLiabilityPayment" DROP CONSTRAINT "PayrollLiabilityPayment_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLiabilityPayment" DROP CONSTRAINT "PayrollLiabilityPayment_entityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLiabilityPayment" DROP CONSTRAINT "PayrollLiabilityPayment_journalEntryId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLiabilityPayment" DROP CONSTRAINT "PayrollLiabilityPayment_liabilityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLine" DROP CONSTRAINT "PayrollLine_entityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollLine" DROP CONSTRAINT "PayrollLine_runId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollMapping" DROP CONSTRAINT "PayrollMapping_defaultAccountId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollMapping" DROP CONSTRAINT "PayrollMapping_entityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_entityId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_journalEntryId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_mappingId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_postedById_fkey";

-- AlterTable
ALTER TABLE "Entity" DROP COLUMN "payeDueDay",
DROP COLUMN "ssnitDueDay";

-- DropTable
DROP TABLE "PayrollAllocation";

-- DropTable
DROP TABLE "PayrollDepartment";

-- DropTable
DROP TABLE "PayrollLiability";

-- DropTable
DROP TABLE "PayrollLiabilityPayment";

-- DropTable
DROP TABLE "PayrollLine";

-- DropTable
DROP TABLE "PayrollMapping";

-- DropTable
DROP TABLE "PayrollRun";

-- DropEnum
DROP TYPE "PayrollLiabilityKind";

-- DropEnum
DROP TYPE "PayrollRunStatus";

