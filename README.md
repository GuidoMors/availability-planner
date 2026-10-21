# Availability Planner API

The API is an Express and Prisma application using SQLite for application data and server-side sessions. The React/Vite client is maintained in the sibling `commontime` folder.

## Requirements

- Node.js 20+

## Run locally

From this repository root:

1. Copy `.env.example` to `.env`. Set `SESSION_SECRET` to a unique random value; keep the SQLite `DATABASE_URL` as provided unless you want the database in another location.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create/update the SQLite schema and generate Prisma Client:
   ```bash
   npm run db:migrate
   ```
4. Start the API:
   ```bash
   npm run dev
   ```

The API listens on `http://localhost:4000`. The database file is `server/availability.db`; the SQLite session store is in that same file. To run the client locally, start it from `commontime`; its Vite server proxies `/api` requests to this API.

## Database and deployments

- SQLite does not need a separate database server, Docker, or database hosting. The API process reads and writes the database file directly.
- Back up `server/availability.db` regularly and verify you can restore it.
- The API host must provide persistent storage at the path specified by `DATABASE_URL`. Ephemeral storage can lose the database on restart or redeploy. Run a single API instance because SQLite is a local file, not a shared multi-instance database.
- The earlier PostgreSQL migration history is archived in `server/prisma/migrations-postgresql`; use the SQLite migrations in `server/prisma/migrations` for new SQLite databases.
- The PostgreSQL database previously used in this development workspace was copied into its local SQLite database. This database file is ignored by Git and is not included in a clone or deployment. The PostgreSQL source was left unchanged; the two databases do not stay in sync. Back up and verify your SQLite file before retiring the old PostgreSQL copy.
- Existing PostgreSQL data is not automatically imported by the SQLite migrations. For a different database or deployment, use a deliberate data migration and verify it before switching traffic.

Use `npm run db:deploy` to apply already-created migrations in a production environment. `npm run db:migrate` is for local development and can create migrations.

## Configuration

- `DATABASE_URL`: SQLite file URL; the example points to `server/availability.db`.
- `SESSION_SECRET`: use a long, unique secret of at least 32 characters in production.
- `APP_URL`: client origin used by the API, defaulting to `http://localhost:5173`.
- `CORS_ORIGINS`: comma-separated client origins allowed to make credentialed API requests.
- For a deployed Cloudflare Pages client, set its `VITE_API_BASE_URL` to the API's HTTPS origin. Set `APP_URL` and `CORS_ORIGINS` to the exact Pages origin and use `SESSION_COOKIE_SAME_SITE=none` and `SESSION_COOKIE_SECURE=true`. A Pages site using `localhost` reaches the visitor's computer, not your backend.
- Configure SMTP settings to send password reset emails. Without SMTP, reset links are only logged in development; never use console delivery in production.
- Use HTTPS in production. Session cookies are HTTP-only and secure in production.

## API features

- Username/password registration and login using Argon2id password hashes. Email is optional and only needed for email-based password recovery; accounts without an email cannot recover a forgotten password.
- Session-based authentication; passwords and password hashes are never returned by the API.
- Password reset tokens are hashed, single-use, and expire after 30 minutes.
- Standard weekly availability with 672 quarter-hour slots.
- Alternating biweekly overrides anchored to a selected Monday, plus one-off week overrides. Unchanged slots inherit the regular weekly schedule.
- Group memberships, shared availability, and group-owner-assigned schedules.
- Authenticated by-username profile schedules, including inspected users' group memberships and scheduled group sessions.

## Notes

- Availability uses local wall-clock quarter-hour slots; this starter does not model time zones per user.
- In personal schedule views, assigned group slots display personal availability and the group's color in separate halves. Group calendar colors indicate shared availability; owner-assigned sessions use the group's color.
- This is a functional starter UI, not a polished production calendar.
