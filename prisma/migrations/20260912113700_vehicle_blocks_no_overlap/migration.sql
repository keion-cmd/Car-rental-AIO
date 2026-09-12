-- Extensions required for the availability exclusion constraint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A vehicle cannot have two blocks (bookings, holds, maintenance, manual,
-- transfer) with overlapping [start, end) periods. Ranges are half-open
-- (tstzrange default bounds '[)'), so a block ending exactly when another
-- begins is not an overlap.
ALTER TABLE "vehicle_blocks"
  ADD CONSTRAINT "vehicle_blocks_no_overlap"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    "period" WITH &&
  );
