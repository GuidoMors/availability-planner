# Availability Planner

A starter full-stack weekly availability app built with React + TypeScript, Express, Prisma, and PostgreSQL.

## Requirements
- Node.js 20+
- Docker with Docker Compose (or a local PostgreSQL instance)

## Run locally
1. Copy .env.example and docker-compose.yml.example and rename them to .env and docker-compose.yml:
   Make sure to edit:
   - the secret key in .env
   - the database username and password in docker-compose.yml
   - set the databae username and password correct in .env
2. Start PostgreSQL:
   ```bash
   docker compose up -d db
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create the database schema and generate Prisma Client:
   ```bash
   npm run db:migrate
   ```
5. Start frontend and backend:
   ```bash
   npm run dev
   ```
6. Open http://localhost:5173

The frontend proxies `/api` requests to Express on port 4000.

## Important configuration
- Set `SESSION_SECRET` to a long random secret before deployment.
- Configure `APP_URL` and SMTP settings before enabling email delivery.
- In development, password-reset links are logged to the API console if SMTP is not configured. Never use console delivery in production.
- Use HTTPS in production. Session cookies are HTTP-only and secure in production.
- Configure a real email provider, monitoring, backups, and rate limits at the reverse proxy before public launch.

## Included
- Username/email/password registration and username/password login using Argon2id password hashes.
- Session-based authentication; passwords and password hashes are never returned by the API.
- Password reset token flow with hashed, single-use, expiring tokens.
- Standard weekly schedule (672 quarter-hour slots).
- Alternating biweekly schedule snapshots anchored to a selected Monday, alongside one-off week overrides.
- Custom week overrides stored as changed slots, initialized from the standard schedule.
- Public-by-username profile schedule view.
- Groups, membership, and group availability aggregation.
- Responsive starter UI with standard/custom schedule editor and group color key.

## Notes
- Availability is stored in the user's local wall-clock quarter-hour slots. This starter does not model different time zones per user; decide a product-wide timezone policy before deployment.
- Availability layers: "everyone" availability (green) is the base schedule. Each group also has its own colour and an optional group-only layer; toggling in group mode on the Edit schedule page edits only that layer. A group's shared calendar counts everyone-availability plus that group's own layer and ignores other groups' layers.
- Group color rules: green = everyone available, red = everyone unavailable, yellow = exactly one unavailable, orange = mixed with two or more unavailable.
- The UI is a functional starter, not a polished production calendar. It uses simple day/slot controls to keep the project easy to extend.
