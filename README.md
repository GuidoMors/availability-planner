# Availability Planner API

The API is a TypeScript Cloudflare Worker using Prisma ORM with Cloudflare D1. The React/Vite client is maintained in the sibling `commontime` repository and is deployed separately to Cloudflare Pages. The old SQLite file is retained locally as the source for a deliberate D1 data import; it is not used by the Worker.

## Requirements

- Node.js 22.13 or newer (includes the built-in SQLite module used by the data migration tools)
- A Cloudflare account for D1/Worker deployment

## Local development

From this repository root:

1. Install packages:
   ```bash
   npm install
   ```
2. Copy `server/.dev.vars.example` to `server/.dev.vars`. Set `SESSION_SECRET` to a unique random value of at least 32 characters. Keep these development values:
   - `CORS_ORIGINS=http://localhost:5173`
   - `SESSION_COOKIE_SAME_SITE=lax`
   - `SESSION_COOKIE_SECURE=false`
3. Create a local D1 database and apply the schema:
   ```bash
   npm run db:migrate:local
   ```
4. Start the Worker:
   ```bash
   npm run dev
   ```
   Wrangler serves the local API at `http://localhost:8787`.
5. In `commontime`, run `npm install` and `npm run dev`. Vite proxies `/api` to the local Worker at port 8787.

Local D1 data is separate from `server/availability.db`. To use the imported schedules locally, export the SQLite data and execute the resulting SQL against local D1 as described in the migration section below.

## Create and deploy Cloudflare D1 + Worker

From the backend repository root:

1. Authenticate with Wrangler and create the database:
   ```bash
   npx wrangler login
   npx wrangler d1 create availability-planner
   ```
2. Copy the returned `database_id` into `server/wrangler.jsonc`, replacing the all-zero placeholder. Keep the binding name `DB` and database name `availability-planner`.
3. Configure the production values in `server/wrangler.jsonc`:
   - `CORS_ORIGINS`: the same exact origin (comma-separate additional trusted origins)
   - `SESSION_COOKIE_SAME_SITE`: `none`
   - `SESSION_COOKIE_SECURE`: `true`
4. Apply any new D1 migrations:
   ```bash
   npm run db:migrate:remote
   ```
5. Add production secrets:
   ```bash
   npx wrangler secret put SESSION_SECRET --config server/wrangler.jsonc
   ```
   Use the existing `SESSION_SECRET` from the former API if you want imported active sessions to remain valid; otherwise users will need to sign in again. Do not commit `.dev.vars`, secrets, or SQL exports.
6. Deploy:
   ```bash
   npm run deploy
   ```

## Import existing SQLite data into D1

The existing `server/availability.db` is ignored by Git and stays unchanged by this procedure. Back it up before migrating. The importer refuses to export a database with missing tables or foreign-key violations.

1. Create the remote D1 database and apply the schema as above.
2. From the backend repository root, export a data-only SQL file:
   ```bash
   npm run db:export-sqlite
   ```
   It creates ignored `server/d1-import.sql`; this contains account and schedule data, so do not commit or share it.
3. Import the data:
   ```bash
   npx wrangler d1 execute availability-planner --remote --config server/wrangler.jsonc --file=server/d1-import.sql
   ```
   For local development, use `--local` in place of `--remote`:
   ```bash
   npx wrangler d1 execute availability-planner --local --config server/wrangler.jsonc --file=server/d1-import.sql
   ```
4. Verify row counts before switching the Pages site to the Worker. For example:
   ```bash
   npx wrangler d1 execute availability-planner --remote --config server/wrangler.jsonc --command="SELECT (SELECT COUNT(*) FROM \"User\") AS users, (SELECT COUNT(*) FROM \"StandardSlot\") AS standard_slots, (SELECT COUNT(*) FROM \"PlannerGroup\") AS groups;"
   ```
   Compare these values with the table counts printed by the export script. Also test login/session behavior, schedules, groups, and representative shared views before directing users to the new API. Keep the SQLite and PostgreSQL source copies unchanged until the D1 import has been verified.

The D1 migration creates the schema and Worker rate-limit table; the export script imports rows only and does not overwrite schema or migration records.

## Existing account passwords

Existing users have Argon2id hashes. That legacy hashing workload does not fit reliably within Cloudflare Workers Free's 10 ms CPU limit, so the Worker deliberately does not attempt to verify those hashes. The imported schedules, groups, users, and sessions are preserved, but legacy users must set a new password:

- Users with a still-valid imported session can use the in-app password migration prompt. Session continuity requires importing `user_sessions` (the exporter does this) and setting the same `SESSION_SECRET` in Cloudflare.
- Existing users also need a recovery key. For each account, the administrator can generate one:
  ```bash
  npm run db:recovery-key -w server -- <username>
  npx wrangler d1 execute availability-planner --remote --config server/wrangler.jsonc --file=server/d1-recovery-key.sql
  ```
  The command displays the recovery key once and writes only its hash to the SQL file. Confirm Wrangler returns the intended username, share the key privately with that account owner, then securely delete the ignored SQL file. The user can then use **Forgot password** to set a new password. For an account without a valid session, this also replaces the legacy Argon2 password.

New accounts receive a high-entropy recovery key displayed only once after signup. D1 stores only its SHA-256 hash. Recovery keys are single-use: successful recovery consumes the key, changes the password, and signs out existing sessions. New, migrated, and recovered passwords must be 6–128 characters and are stored as PBKDF2-SHA-256 hashes using 100,000 iterations via Web Crypto, the iteration ceiling supported by Cloudflare Workers' Web Crypto implementation. The Worker enforces credentialed CORS, HTTP-only signed sessions, D1-backed rate limits, and the existing API route behavior.

## Useful commands

- `npm run typecheck` — check Worker and generated Prisma Client types
- `npm run build` — Prisma generation and Wrangler dry-run bundle
- `npm run db:generate` — regenerate the Prisma Client
- `npm run db:migrate:local` / `npm run db:migrate:remote` — apply D1 migrations
- `npm run db:export-sqlite` — export the local SQLite data for import
- `npm run deploy` — deploy the Worker

For Cloudflare Pages build settings and frontend configuration, see the separate `commontime` repository README.
