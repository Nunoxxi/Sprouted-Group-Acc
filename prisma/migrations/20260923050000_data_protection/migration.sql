-- CreateTable
CREATE TABLE "DataSubjectRequest" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "note" TEXT,
    "pseudonym" TEXT,
    "fieldsChanged" INTEGER NOT NULL DEFAULT 0,
    "handledById" TEXT,
    "handledByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSubjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataSubjectRequest_entityId_createdAt_idx" ON "DataSubjectRequest"("entityId", "createdAt");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_entityId_subjectKind_subjectId_idx" ON "DataSubjectRequest"("entityId", "subjectKind", "subjectId");

-- AddForeignKey
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

