-- Drafts have no number until they are posted. With '' the (entityId, number)
-- unique index stopped an entity holding a second draft; NULLs are distinct.
-- AlterTable
ALTER TABLE "Document" ALTER COLUMN "number" DROP NOT NULL;

-- Existing drafts saved with an empty number.
UPDATE "Document" SET "number" = NULL WHERE "number" = '' AND "status" = 'DRAFT';
