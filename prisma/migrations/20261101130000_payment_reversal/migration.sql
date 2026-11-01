-- A recorded payment can be reversed: a mirror-image journal, the row kept.
ALTER TABLE "Payment" ADD COLUMN "reversalEntryId" TEXT,
ADD COLUMN "reversedById" TEXT,
ADD COLUMN "reversedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Payment_reversalEntryId_key" ON "Payment"("reversalEntryId");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
