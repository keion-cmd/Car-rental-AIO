-- Enable Row Level Security on all application tables in the public schema.
-- No policies are created: RLS-enabled-with-zero-policies denies all access
-- to the anon/authenticated Supabase roles by default. Prisma connects as
-- the database owner (BYPASSRLS), so the application is unaffected.
--
-- _prisma_migrations is intentionally excluded: Prisma manages this table
-- and altering it risks breaking migration tracking.
--
-- FORCE ROW LEVEL SECURITY is intentionally NOT used: it would subject the
-- table owner (Prisma's connection role) to RLS as well, breaking the app.

ALTER TABLE "booking_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_pairs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_models" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicles" ENABLE ROW LEVEL SECURITY;
