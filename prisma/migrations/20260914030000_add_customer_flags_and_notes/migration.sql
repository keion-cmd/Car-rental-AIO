-- CreateEnum
CREATE TYPE "CustomerFlag" AS ENUM ('VIP', 'REQUIRES_DEPOSIT', 'BLACKLISTED');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "flag" "CustomerFlag",
ADD COLUMN     "flag_reason" TEXT,
ADD COLUMN     "flagged_at" TIMESTAMPTZ,
ADD COLUMN     "flagged_by_id" UUID,
ADD COLUMN     "staff_notes" TEXT;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_flagged_by_id_fkey" FOREIGN KEY ("flagged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
