-- Per-entity sender address for invitations and password resets.
ALTER TABLE "Entity" ADD COLUMN "emailFrom" TEXT;
