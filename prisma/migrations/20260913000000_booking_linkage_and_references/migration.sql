-- Zero rows existed in bookings/quotes/vehicle_blocks at the time this
-- migration was written (verified directly against the DB), so `reference`
-- and `expires_at` are added NOT NULL with no backfill step required.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ,
ADD COLUMN     "reference" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "expires_at" TIMESTAMPTZ NOT NULL;

-- AlterTable
ALTER TABLE "vehicle_blocks" ADD COLUMN     "booking_id" UUID,
ADD COLUMN     "quote_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");

-- CreateIndex
CREATE INDEX "vehicle_blocks_booking_id_idx" ON "vehicle_blocks"("booking_id");

-- AddForeignKey
ALTER TABLE "vehicle_blocks" ADD CONSTRAINT "vehicle_blocks_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_blocks" ADD CONSTRAINT "vehicle_blocks_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
