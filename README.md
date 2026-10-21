# Availability Planner

A starter full-stack weekly availability app built with React + TypeScript, Express, Prisma, and PostgreSQL.

## Requirements
- Node.js 20+
- Docker with Docker Compose (or a local PostgreSQL instance)

## Run locally
1. Copy .env.example and docker-compose.yml.example and rename them to .env and docker-compose.yml (you might also need an .env in client)
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
- Alternating biweekly availability overrides anchored to a selected Monday, alongside one-off week overrides. Unchanged slots inherit the current weekly schedule.
- Custom week overrides stored as changed slots, initialized from the standard schedule.
- Biweekly and specific-week changes are highlighted against the regular weekly schedule; click a highlighted slot to restore that slot to its weekly hours.
- Clear controls remove all every-other-week overrides or the selected specific week's overrides, returning that schedule scope to the regular weekly hours.
- Authenticated by-username profile schedule view, including the inspected person's group memberships and scheduled group sessions.
- Groups, membership, and group availability aggregation.
- Responsive starter UI with standard/custom schedule editor and group color key.

## Notes
- Availability is stored in the user's local wall-clock quarter-hour slots. This starter does not model different time zones per user; decide a product-wide timezone policy before deployment.
- Availability layers: "everyone" availability (green) is each person's personal schedule. Group assignments are created only from the Groups page; only a group owner can assign recurring, alternating, or one-week times to their group. Group assignments are separate from personal availability, which members can continue to edit. In personal schedule views, the top half of an assigned slot shows personal availability and the bottom half shows the group's color.
- When inspecting a person's profile, all of their group sessions are shown, including groups the viewer does not belong to.
- Group calendar colors: green = everyone available, red = two or more unavailable, yellow = exactly one unavailable. Owner-assigned group sessions use the group's color.
- The UI is a functional starter, not a polished production calendar. It uses simple day/slot controls to keep the project easy to extend.
