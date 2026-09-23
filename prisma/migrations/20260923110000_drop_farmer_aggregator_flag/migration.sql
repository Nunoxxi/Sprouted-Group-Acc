-- Drop Contact.isFarmerAggregator.
--
-- The flag drove nothing: it was stored, shown as a label on the contact card,
-- and read by no tax rule, report or buying workflow. It also overlapped with
-- Contact.category, which already has a FARMER option, so one contact could
-- say two different things about itself.
--
-- Nothing is lost. Of the two rows carrying it, Nana Akua Farms is already
-- category FARMER and Sprouted Roots is a GROUP_ENTITY that should not have
-- been flagged. Farmers the app actually buys from live in the Farmer table,
-- not here.

-- AlterTable
ALTER TABLE "Contact" DROP COLUMN "isFarmerAggregator";

