-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "odometer_out" INTEGER,
ADD COLUMN     "odometer_in" INTEGER,
ADD COLUMN     "fuel_out" INTEGER,
ADD COLUMN     "fuel_in" INTEGER,
ADD COLUMN     "checked_out_at" TIMESTAMPTZ,
ADD COLUMN     "checked_in_at" TIMESTAMPTZ,
ADD COLUMN     "checked_out_by_id" UUID,
ADD COLUMN     "checked_in_by_id" UUID;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_checked_out_by_id_fkey" FOREIGN KEY ("checked_out_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_checked_in_by_id_fkey" FOREIGN KEY ("checked_in_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
