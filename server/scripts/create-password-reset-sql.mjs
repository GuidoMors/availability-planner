import { pbkdf2Sync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = resolve(serverDir, "d1-password-reset.sql");
const iterations = 600_000;

function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this command in an interactive terminal so the password is not echoed.");
  }
  return new Promise(resolveAnswer => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const onData = chunk => {
      for (const key of chunk.toString("utf8")) {
        if (key === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.exit(130);
        }
        if (key === "\r" || key === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolveAnswer(value);
          return;
        }
        if (key === "\u007f" || key === "\b") value = value.slice(0, -1);
        else if (key >= " ") value += key;
      }
    };
    process.stdin.on("data", onData);
  });
}

const username = process.argv[2]?.trim().toLowerCase();
if (!username || username.length > 24) {
  console.error("Usage: npm run db:reset-password -w server -- <username>");
  process.exit(1);
}

const password = await readHidden("New password (12-128 characters): ");
if (password.length < 12 || password.length > 128) {
  console.error("Password must be 12-128 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const derived = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const encode = value => value.toString("base64url");
const hash = `pbkdf2$sha256$${iterations}$${encode(salt)}$${encode(derived)}`;
const escapedUsername = username.replaceAll("'", "''");
writeFileSync(
  outputPath,
  `UPDATE "User" SET "passwordHash" = '${hash}' WHERE "username" = '${escapedUsername}';\n`,
  { encoding: "utf8", mode: 0o600 }
);
console.log(`Created ${outputPath}. Apply it with Wrangler, then securely delete the SQL file.`);
