-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "amount_paid" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "staff_notes" TEXT;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "business_timezone" TEXT NOT NULL DEFAULT 'Asia/Manila';

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "fleet_number" TEXT,
ADD COLUMN     "year" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_fleet_number_key" ON "vehicles"("fleet_number");
