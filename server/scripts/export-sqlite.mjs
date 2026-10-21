import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const databasePath = resolve(serverDir, "availability.db");
const outputPath = resolve(serverDir, "d1-import.sql");
const tableOrder = [
  "User",
  "PlannerGroup",
  "CustomWeek",
  "GroupBiweeklySchedule",
  "StandardSlot",
  "CustomSlot",
  "GroupMember",
  "PasswordResetToken",
  "GroupStandardSlot",
  "GroupCustomSlot",
  "GroupBiweeklySlot",
  "BiweeklySlot",
  "user_sessions"
];

const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;
const sqlValue = value => {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
};

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`SQLite contains ${violations.length} foreign-key violations; refusing export.`);

  const available = new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(row => row.name));
  const missing = tableOrder.filter(table => !available.has(table));
  if (missing.length) throw new Error(`Required tables are missing: ${missing.join(", ")}`);

  const statements = ["-- Data-only export for the D1 schema in migrations/0001_init.sql."];
  for (const table of tableOrder) {
    const quotedTable = quoteIdentifier(table);
    const columns = database.prepare(`PRAGMA table_info(${quotedTable})`).all().map(row => row.name);
    const quotedColumns = columns.map(quoteIdentifier).join(", ");
    const rows = database.prepare(`SELECT * FROM ${quotedTable}`).all();
    for (const row of rows) {
      const values = columns.map(column => sqlValue(row[column])).join(", ");
      statements.push(`INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${values});`);
    }
    console.log(`${table}: ${rows.length} rows`);
  }

  writeFileSync(outputPath, `${statements.join("\n")}\n`, "utf8");
  console.log(`Data export created: ${outputPath}`);
  console.log("This file contains account and schedule data. Do not commit or share it.");
} finally {
  database.close();
}
