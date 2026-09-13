-- DropForeignKey
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_customer_id_fkey";

-- AlterTable
ALTER TABLE "quotes" ALTER COLUMN "customer_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

