-- CreateEnum
CREATE TYPE "AttachmentTargetKind" AS ENUM ('INVOICE', 'BILL', 'PAYMENT', 'JOURNAL', 'AGENT_PURCHASE', 'STOCK_COUNT', 'FIXED_ASSET', 'INBOX');

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "targetKind" "AttachmentTargetKind" NOT NULL DEFAULT 'INBOX',
    "targetId" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "note" TEXT,
    "matchedAt" TIMESTAMP(3),
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "targetKind" "AttachmentTargetKind" NOT NULL,
    "thresholdMinor" BIGINT NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_entityId_targetKind_targetId_idx" ON "Attachment"("entityId", "targetKind", "targetId");

-- CreateIndex
CREATE INDEX "Attachment_entityId_uploadedAt_idx" ON "Attachment"("entityId", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentRule_entityId_targetKind_key" ON "AttachmentRule"("entityId", "targetKind");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentRule" ADD CONSTRAINT "AttachmentRule_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

