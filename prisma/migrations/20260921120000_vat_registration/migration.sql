-- VAT registration per entity, dormant by default.

CREATE TYPE "SaleType" AS ENUM ('DOMESTIC', 'EXPORT');

ALTER TABLE "Entity" ADD COLUMN "vatRegisteredFrom" DATE;

ALTER TABLE "Document"
  ADD COLUMN "saleType" "SaleType" NOT NULL DEFAULT 'DOMESTIC',
  ADD COLUMN "importVatMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "vatApplied" BOOLEAN NOT NULL DEFAULT false;

-- Every document posted before this migration had VAT calculated on it (the
-- old behaviour for every entity). Record that, so their posted totals still
-- read as they were posted.
UPDATE "Document" SET "vatApplied" = true WHERE "status" <> 'DRAFT';

-- None of the group's entities is VAT registered.
UPDATE "Entity" SET "vatRegistered" = false, "vatRegisteredFrom" = NULL;
