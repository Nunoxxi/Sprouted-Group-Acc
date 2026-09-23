-- CreateTable
CREATE TABLE "DatabaseMarker" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "environment" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "markedBy" TEXT,

    CONSTRAINT "DatabaseMarker_pkey" PRIMARY KEY ("id")
);

