-- AlterTable
ALTER TABLE "AdvanceDelivery" ADD COLUMN     "assayedBy" TEXT,
ADD COLUMN     "bags" INTEGER,
ADD COLUMN     "grossGrams" BIGINT,
ADD COLUMN     "tareGrams" BIGINT,
ADD COLUMN     "vehicle" TEXT,
ADD COLUMN     "waybill" TEXT;
