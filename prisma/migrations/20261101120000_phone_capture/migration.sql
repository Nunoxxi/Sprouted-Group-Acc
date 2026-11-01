-- Documents sent from the phone capture page: what the person said it is,
-- the amount and date they gave, and the phone's own reference so a resend
-- is recognised. All new and nullable; nothing already stored changes.

-- CreateEnum
CREATE TYPE "CaptureKind" AS ENUM ('BILL', 'INVOICE', 'EXPENSE_CLAIM', 'RECEIPT');

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "amountMinor" BIGINT,
ADD COLUMN     "capturedAs" "CaptureKind",
ADD COLUMN     "clientRef" TEXT,
ADD COLUMN     "documentDate" DATE;

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_clientRef_key" ON "Attachment"("clientRef");
