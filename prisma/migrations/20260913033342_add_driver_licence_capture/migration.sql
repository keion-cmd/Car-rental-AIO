-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "driver_email" TEXT NOT NULL,
ADD COLUMN     "driver_full_name" TEXT NOT NULL,
ADD COLUMN     "driver_licence_country" TEXT NOT NULL,
ADD COLUMN     "driver_licence_expiry" TIMESTAMPTZ NOT NULL,
ADD COLUMN     "driver_licence_number" TEXT NOT NULL,
ADD COLUMN     "driver_phone" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "date_of_birth" TIMESTAMPTZ;
