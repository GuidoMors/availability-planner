import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = resolve(serverDir, "d1-recovery-key.sql");
const username = process.argv[2]?.trim().toLowerCase();

if (!username || username.length > 24 || !/^[a-z0-9_]+$/.test(username)) {
  console.error("Usage: npm run db:recovery-key -w server -- <username>");
  process.exit(1);
}

const recoveryKey = randomBytes(32).toString("base64url");
const recoveryKeyHash = createHash("sha256").update(recoveryKey).digest("hex");
const escapedUsername = username.replaceAll("'", "''");
writeFileSync(
  outputPath,
  `UPDATE "User" SET "recoveryKeyHash" = '${recoveryKeyHash}' WHERE lower("username") = '${escapedUsername}' RETURNING "username";\n`,
  { encoding: "utf8", mode: 0o600 }
);

console.log(`Recovery key for ${username} (shown once; share it privately):\n${recoveryKey}`);
console.log(`SQL written to ${outputPath}. Apply it with Wrangler, confirm the username was returned, then securely delete the SQL file.`);
