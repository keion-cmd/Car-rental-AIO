/*
  Warnings:

  - You are about to drop the column `amount` on the `booking_line_items` table. All the data in the column will be lost.
  - Added the required column `total_amount` to the `booking_line_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `booking_line_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `unit_amount` to the `booking_line_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `daily_rate` to the `vehicles` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "LineItemType" AS ENUM ('BASE_RATE', 'SURCHARGE', 'FEE', 'TAX', 'DISCOUNT', 'ADDON', 'PROTECTION', 'EXTRA_CHARGE');

-- AlterTable
-- booking_line_items has never been written to (verified row count = 0
-- before migrating), so amount -> total_amount is a true rename, not a
-- drop+recreate that would lose data.
ALTER TABLE "booking_line_items" RENAME COLUMN "amount" TO "total_amount";
ALTER TABLE "booking_line_items"
ADD COLUMN     "is_taxable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "type" "LineItemType" NOT NULL,
ADD COLUMN     "unit_amount" BIGINT NOT NULL;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "rental_days" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "security_deposit" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "subtotal_amount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tax_amount" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "rental_days" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "security_deposit" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "subtotal_amount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tax_amount" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "billing_grace_minutes" INTEGER NOT NULL DEFAULT 59,
ADD COLUMN     "tax_rate_bps" INTEGER NOT NULL DEFAULT 1200,
ADD COLUMN     "young_driver_max_age" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "young_driver_surcharge_per_day" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
-- daily_rate keeps DEFAULT 0 (NOT NULL still enforced) so existing rows
-- backfill cleanly and non-pricing code paths that create a Vehicle
-- without pricing data keep working ahead of the pricing engine phase.
ALTER TABLE "vehicles" ADD COLUMN     "daily_rate" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "extra_km_rate" BIGINT,
ADD COLUMN     "included_km_per_day" INTEGER,
ADD COLUMN     "max_rental_days" INTEGER,
ADD COLUMN     "min_driver_age" INTEGER NOT NULL DEFAULT 21,
ADD COLUMN     "min_rental_days" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "monthly_rate" BIGINT,
ADD COLUMN     "security_deposit" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "weekly_rate" BIGINT;

-- CreateTable
CREATE TABLE "quote_line_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "quote_id" UUID NOT NULL,
    "type" "LineItemType" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_amount" BIGINT NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_line_items_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
