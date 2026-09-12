# Handoff Notes

## Current phase

P1-P2 complete. Prior phase P1-P1-R4 committed at `75c839171a2e6c74611913eddcb862b926688e0`.

## Database

Local embedded Postgres, provisioned via a devDependency (not Docker, not remote Supabase),
listening on port `54329`, database name `car_rental_dev`.

### Env variable layout

`.env.local` is gitignored and is **not** present in the repo — it must be recreated by hand
on any new machine. Required variable **names** (values are never stored here):

- `DATABASE_URL` — points at the local embedded Postgres instance
- `DIRECT_URL` — points at the local embedded Postgres instance
- `REMOTE_DATABASE_URL` — holds the Supabase pooled connection string; **unused for now**
- `REMOTE_DIRECT_URL` — holds the Supabase direct connection string; **unused for now**

### Permanent rule

Prisma is the sole migration authority. Never run `supabase migration new`,
`supabase db diff`, `supabase db push`, or `supabase link`. All schema changes go through
Prisma migrations only.

### Remote Supabase status

No schema has been applied to the remote Supabase project. Remote migration is a future,
explicitly deferred phase — it is blocked on the Supabase direct-connect host being
IPv6-only, which is not reachable from the current environment.

## Schema: tables and enums

Enums: `VehicleTransmission`, `VehicleFuelType`, `BookingStatus`, `PaymentStatus`,
`BlockType`, `BookingSource`, `QuoteStatus`, `MaintenanceType`, `MaintenanceStatus`,
`UserRole`.

Tables: `settings`, `users`, `locations`, `location_pairs`, `vehicle_categories`,
`vehicle_models`, `vehicles`, `vehicle_images`, `customers`, `quotes`, `bookings`,
`booking_line_items`, `maintenance_records`, `vehicle_blocks`.

## The `vehicle_blocks` exclusion constraint

`vehicle_blocks` has a `period` column of type `tstzrange` (Prisma models it via
`Unsupported("tstzrange")`) with a Postgres `EXCLUDE USING gist` constraint plus a GiST
index, created via raw SQL in `prisma/migrations` since Prisma cannot express
`EXCLUDE USING gist` natively.

This constraint is what prevents two overlapping blocks (bookings, holds, maintenance,
manual blocks, transfers) from existing on the same vehicle at the database level. It must
never be dropped or bypassed — it is the sole guarantee against double-booking a vehicle,
and no application-level check should be treated as a substitute for it.

## Deferred (not yet built)

- Row-level security (RLS) policies
- Tables: `payments`, `addons`, `pricing_rules`, `promo_codes`, `notifications`,
  `audit_logs`
- All UI
- Authentication
- Remote Supabase migration (see above)

## NO-GO list

Do not, without explicit sign-off:

- Add pages or auth (none exist as of P1-P2)
- Alter or bypass the `vehicle_blocks` exclusion constraint
- Change the money-as-`BigInt` (minor units) rule for monetary columns
- Change timestamp storage away from `timestamptz` / UTC
- Change the half-open `[start, end)` range semantics used for block/booking periods

## Known debt (P1-P4)

- `app/page.tsx` contains hardcoded `fleet` and `locations` arrays with invented field
  names that do not match `Vehicle` / `VehicleModel` / `VehicleCategory` / `Location`. To be
  replaced with real queries.
- Prices are pre-formatted strings (e.g. "₱1,850"). Must become BIGINT minor units
  formatted at render time. Never reintroduce string or float money.
- The search form's submit handler only calls `preventDefault()` and sets a boolean. It
  does not search.
- Date and time inputs are uncontrolled static defaults with no timezone handling.
- Drop-off location exists but is hidden behind a "Return to a different location"
  checkbox. Acceptable as a progressive-disclosure pattern; it must remain functional, not
  decorative.
- `app/page.tsx` is one monolithic file. Extraction is deferred, not forgotten.

## Vercel

The Vercel project is connected to this repo and will trigger a deployment on every push
to `main`. The app currently has no database reachable from Vercel and no pages that query
one, so a failed or no-op deployment is expected and irrelevant until real pages exist. No
Vercel environment variables, `vercel.json`, or git-integration changes were made in this
phase.
