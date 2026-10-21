import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import cors from "cors";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const app = express();
const prisma = new PrismaClient();
const port = Number(process.env.PORT || 4000);
const appUrl = process.env.APP_URL || "http://localhost:5173";
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET must be at least 32 characters in production.");
}

app.set("trust proxy", 1);
app.use(cors({ origin: appUrl, credentials: true }));
app.use(express.json({ limit: "100kb" }));
const PgStore = connectPgSimple(session);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(session({
  store: new PgStore({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  name: "availability.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret-32chars",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });

function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);
}
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
  next();
}
const usernameSchema = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/, "Use letters, numbers, and underscores only.");
const slotsSchema = z.array(z.object({ day: z.number().int().min(0).max(6), slot: z.number().int().min(0).max(95), available: z.boolean() })).max(672);
const weekSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const validWeekStart = (s: string) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 1 && d.toISOString().slice(0, 10) === s;
};
const weekParity = (weekStart: string, anchor: Date) => ((Math.floor((monday(weekStart).getTime() - anchor.getTime()) / 604800000) % 2) + 2) % 2;
async function getStandard(userId: string): Promise<boolean[][]> {
  const rows = await prisma.standardSlot.findMany({ where: { userId } });
  const grid = Array.from({ length: 7 }, () => Array<boolean>(96).fill(false));
  for (const r of rows) grid[r.day][r.slot] = r.available;
  return grid;
}
async function getEffectiveWeek(userId: string, weekStart: string): Promise<boolean[][]> {
  const grid = await getStandard(userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { biweeklyAnchorWeekStart: true } });
  if (user?.biweeklyAnchorWeekStart) {
    const biweekly = await prisma.biweeklySlot.findMany({ where: { userId, groupId: null, parity: weekParity(weekStart, user.biweeklyAnchorWeekStart) } });
    if (biweekly.length) {
      for (const row of biweekly) grid[row.day][row.slot] = row.groupId === null && row.available;
    }
  }
  const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } }, include: { slots: true } });
  if (custom) for (const s of custom.slots) grid[s.day][s.slot] = s.available;
  return grid;
}
async function getBiweeklyWeek(userId: string, weekStart: string): Promise<boolean[][]> {
  const grid = await getStandard(userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { biweeklyAnchorWeekStart: true } });
  if (!user?.biweeklyAnchorWeekStart) return grid;
  const biweekly = await prisma.biweeklySlot.findMany({ where: { userId, groupId: null, parity: weekParity(weekStart, user.biweeklyAnchorWeekStart) } });
  if (biweekly.length) for (const slot of biweekly) grid[slot.day][slot.slot] = slot.available;
  return grid;
}
async function getCustomWeek(userId: string, weekStart: string): Promise<boolean[][]> {
  const grid = await getStandard(userId);
  const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId, weekStart: monday(weekStart) } }, include: { slots: true } });
  if (custom) for (const slot of custom.slots) grid[slot.day][slot.slot] = slot.available;
  return grid;
}
function flatten(grid: boolean[][]) {
  return grid.flatMap((day, d) => day.map((available, slot) => ({ day: d, slot, available })));
}

const GROUP_COLORS = ["#5667df", "#e0569b", "#9b5de5", "#1ea5d8", "#d97706", "#c026d3", "#2563eb", "#be123c", "#7c4a2d", "#64748b"];
function hslToHex(h: number, s: number, l: number) {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, "0");
  return `#${f(0)}${f(8)}${f(4)}`;
}
async function pickGroupColor() {
  const used = new Set((await prisma.plannerGroup.findMany({ select: { color: true } })).map(g => g.color.toLowerCase()));
  const free = GROUP_COLORS.find(c => !used.has(c));
  if (free) return free;
  // Palette exhausted: generate more distinct hues, skipping the green range reserved for "everyone".
  for (let n = used.size; n < used.size + 1000; n++) {
    let hue = (n * 137.508) % 360;
    if (hue >= 110 && hue <= 190) hue += 90;
    const c = hslToHex(hue % 360, 62, 48);
    if (!used.has(c)) return c;
  }
  return GROUP_COLORS[0];
}
const monday = (weekStart: string) => new Date(`${weekStart}T00:00:00.000Z`);
const currentWeekStart = () => {
  const date = new Date();
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc.toISOString().slice(0, 10);
};
const participantWhere = (userId: string) => ({ OR: [{ ownerId: userId }, { members: { some: { userId } } }] });
async function isParticipant(userId: string, groupId: string) {
  return !!(await prisma.plannerGroup.findFirst({ where: { id: groupId, ...participantWhere(userId) }, select: { id: true } }));
}
const emptyGrid = () => Array.from({ length: 7 }, () => Array<boolean>(96).fill(false));
/** Group assignments are stored on the owner and shared with every participant. */
async function getGroupLayers(_userId: string, groupIds: string[], weekStart?: string, includeCustom = true, includeBiweekly = true): Promise<Map<string, boolean[][]>> {
  const layers = new Map<string, boolean[][]>(groupIds.map(id => [id, emptyGrid()]));
  if (!groupIds.length) return layers;
  const groups = await prisma.plannerGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, ownerId: true } });
  const ownerByGroup = new Map(groups.map(group => [group.id, group.ownerId]));
  const ownerIds = [...new Set(groups.map(group => group.ownerId))];
  const standard = await prisma.groupStandardSlot.findMany({ where: { userId: { in: ownerIds }, groupId: { in: groupIds } } });
  for (const r of standard) if (ownerByGroup.get(r.groupId) === r.userId) layers.get(r.groupId)![r.day][r.slot] = true;
  if (weekStart) {
    if (includeBiweekly) {
      const owners = await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, biweeklyAnchorWeekStart: true } });
      const anchorByOwner = new Map(owners.map(owner => [owner.id, owner.biweeklyAnchorWeekStart]));
      const schedules = await prisma.groupBiweeklySchedule.findMany({
        where: { groupId: { in: groupIds } },
        include: { slots: true }
      });
      for (const group of groups) {
        const anchor = anchorByOwner.get(group.ownerId);
        if (!anchor) continue;
        const schedule = schedules.find(row => row.groupId === group.id && row.parity === weekParity(weekStart, anchor));
        if (!schedule) continue;
        const grid = layers.get(group.id)!;
        for (const row of grid) row.fill(false);
        for (const slot of schedule.slots) grid[slot.day][slot.slot] = true;
      }
    }
    if (includeCustom) {
      const custom = await prisma.groupCustomSlot.findMany({ where: { userId: { in: ownerIds }, groupId: { in: groupIds }, weekStart: monday(weekStart) } });
      for (const r of custom) if (ownerByGroup.get(r.groupId) === r.userId) layers.get(r.groupId)![r.day][r.slot] = r.available;
    }
  }
  return layers;
}
async function groupLayerPayload(userId: string, groups: { id: string; name: string; color: string }[], weekStart: string) {
  const layers = await getGroupLayers(userId, groups.map(g => g.id), weekStart);
  return groups.map(g => ({ id: g.id, name: g.name, color: g.color, slots: flatten(layers.get(g.id)!) }));
}
async function getAllGroupAssignmentLayers(groupIds: string[]) {
  const layers = await getGroupLayers("", groupIds);
  if (!groupIds.length) return layers;
  const groups = await prisma.plannerGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, ownerId: true } });
  const [biweekly, custom] = await Promise.all([
    prisma.groupBiweeklySchedule.findMany({ where: { groupId: { in: groupIds } }, include: { slots: true } }),
    prisma.groupCustomSlot.findMany({
      where: { available: true, weekStart: { gte: monday(currentWeekStart()) }, OR: groups.map(group => ({ groupId: group.id, userId: group.ownerId })) },
      select: { groupId: true, day: true, slot: true }
    })
  ]);
  for (const schedule of biweekly) for (const slot of schedule.slots) layers.get(schedule.groupId)![slot.day][slot.slot] = true;
  for (const slot of custom) layers.get(slot.groupId)![slot.day][slot.slot] = true;
  return layers;
}
async function hasGroupAssignmentConflict(groupId: string, slots: { day: number; slot: number }[], weekStart?: string, ignoredGroupIds: string[] = []) {
  if (!slots.length) return false;
  const group = await prisma.plannerGroup.findUnique({
    where: { id: groupId },
    select: { ownerId: true, members: { select: { userId: true } } }
  });
  if (!group) return true;
  const participants = [...new Set([group.ownerId, ...group.members.map(member => member.userId)])];
  const slotKeys = new Set(slots.map(slot => `${slot.day}:${slot.slot}`));
  for (const userId of participants) {
    const groups = await prisma.plannerGroup.findMany({ where: participantWhere(userId), select: { id: true } });
    const otherIds = groups.map(item => item.id).filter(id => id !== groupId && !ignoredGroupIds.includes(id));
    const layers = await getGroupLayers(userId, otherIds, weekStart);
    for (const layer of layers.values()) for (let d = 0; d < 7; d++) for (let s = 0; s < 96; s++) {
      if (layer[d][s] && slotKeys.has(`${d}:${s}`)) return true;
    }
    if (!weekStart && otherIds.length) {
      const groupOwners = await prisma.plannerGroup.findMany({ where: { id: { in: otherIds } }, select: { id: true, ownerId: true } });
      const [biweekly, custom] = await Promise.all([
        prisma.groupBiweeklySchedule.findMany({ where: { groupId: { in: otherIds } }, include: { slots: true } }),
        prisma.groupCustomSlot.findMany({
          where: { available: true, weekStart: { gte: monday(currentWeekStart()) }, OR: groupOwners.map(other => ({ groupId: other.id, userId: other.ownerId })), AND: [{ OR: slots }] },
          select: { day: true, slot: true }
        })
      ]);
      if (custom.length || biweekly.some(schedule => schedule.slots.some(slot => slotKeys.has(`${slot.day}:${slot.slot}`)))) return true;
    }
  }
  return false;
}
async function hasConflictingGroupAssignments(groups: { groupId: string; slots: { day: number; slot: number; available: boolean }[] }[]) {
  const records = await prisma.plannerGroup.findMany({
    where: { id: { in: groups.map(group => group.groupId) } },
    select: { id: true, ownerId: true, members: { select: { userId: true } } }
  });
  const assignmentByPersonSlot = new Set<string>();
  for (const assignment of groups) {
    const record = records.find(group => group.id === assignment.groupId);
    if (!record) return true;
    const participants = [...new Set([record.ownerId, ...record.members.map(member => member.userId)])];
    for (const slot of assignment.slots) if (slot.available) for (const userId of participants) {
      const key = `${userId}:${slot.day}:${slot.slot}`;
      if (assignmentByPersonSlot.has(key)) return true;
      assignmentByPersonSlot.add(key);
    }
  }
  return false;
}
async function sendResetEmail(to: string, url: string) {
  const host = process.env.SMTP_HOST;
  if (!host) {
    if (isProduction) throw new Error("Email delivery is not configured.");
    console.info(`[DEV ONLY] Password reset link for ${to}: ${url}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host, port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || "no-reply@example.com",
    to, subject: "Reset your Availability Planner password",
    text: `Use this link within 30 minutes to reset your password: ${url}\nIf you did not request this, ignore this email.`
  });
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.post("/api/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const schema = z.object({ username: usernameSchema, email: z.string().trim().email().max(254), password: z.string().min(12).max(128) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Username must be 3–24 letters/numbers/underscores; password must be 12–128 characters." });
  const username = parsed.data.username.toLowerCase();
  const email = parsed.data.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { username } })) return res.status(409).json({ error: "Username is already taken." });
  if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: "Email is already registered." });
  const user = await prisma.user.create({ data: { username, email, passwordHash: await argon2.hash(parsed.data.password, { type: argon2.argon2id }) } });
  await prisma.standardSlot.createMany({ data: Array.from({ length: 672 }, (_, i) => ({ userId: user.id, day: Math.floor(i / 96), slot: i % 96, available: false })) });
  req.session.userId = user.id;
  res.status(201).json({ user: { id: user.id, username: user.username } });
}));
app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
  const parsed = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter username and password." });
  const user = await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });
  if (!user || !(await argon2.verify(user.passwordHash, parsed.data.password))) return res.status(401).json({ error: "Invalid username or password." });
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id;
  res.json({ user: { id: user.id, username: user.username } });
}));
app.post("/api/auth/logout", requireAuth, (req, res) => req.session.destroy(() => { res.clearCookie("availability.sid"); res.status(204).end(); }));
app.get("/api/auth/me", asyncRoute(async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, username: true } });
  res.json({ user });
}));
app.post("/api/auth/forgot-password", resetLimiter, asyncRoute(async (req, res) => {
  const parsed = z.object({ email: z.string().trim().email().max(254) }).safeParse(req.body);
  if (!parsed.success) return res.status(200).json({ message: "If that account exists, recovery instructions will be sent." });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (user) {
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
    try { await sendResetEmail(user.email, `${appUrl}/reset-password?token=${rawToken}`); }
    catch (e) { console.error("Reset email delivery failed", e); }
  }
  res.json({ message: "If that account exists, recovery instructions will be sent." });
}));
app.post("/api/auth/reset-password", resetLimiter, asyncRoute(async (req, res) => {
  const parsed = z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid token or password. Passwords must be at least 12 characters." });
  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!record || record.usedAt || record.expiresAt < new Date()) return res.status(400).json({ error: "Reset link is invalid or expired." });
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await argon2.hash(parsed.data.password, { type: argon2.argon2id }) } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.updateMany({ where: { userId: record.userId, id: { not: record.id }, usedAt: null }, data: { usedAt: new Date() } })
  ]);
  res.json({ message: "Password updated. You can now log in." });
}));

app.get("/api/schedule/standard", requireAuth, asyncRoute(async (req, res) => res.json({ slots: flatten(await getStandard(req.session.userId!)) })));
app.put("/api/schedule/standard", requireAuth, asyncRoute(async (req, res) => {
  const parsed = slotsSchema.safeParse(req.body.slots);
  if (!parsed.success || parsed.data.length !== 672) return res.status(400).json({ error: "Send all 672 weekly slots." });
  const userId = req.session.userId!;
  const current = await getStandard(userId);
  const biweekly = await prisma.biweeklySlot.findMany({ where: { userId, groupId: null }, select: { parity: true, day: true, slot: true, available: true } });
  const custom = await prisma.customSlot.findMany({ where: { customWeek: { userId } }, select: { id: true, day: true, slot: true, available: true } });
  const incoming = new Map(parsed.data.map(slot => [`${slot.day}:${slot.slot}`, slot.available]));
  const biweeklyOverrides = biweekly.filter(row => row.available !== current[row.day][row.slot] && row.available !== incoming.get(`${row.day}:${row.slot}`));
  const redundantCustomIds = custom.filter(row => row.available === incoming.get(`${row.day}:${row.slot}`)).map(row => row.id);
  await prisma.$transaction(async tx => {
    await tx.biweeklySlot.deleteMany({ where: { userId, groupId: null } });
    await Promise.all(parsed.data.map(slot => tx.standardSlot.update({
      where: { userId_day_slot: { userId, day: slot.day, slot: slot.slot } },
      data: { available: slot.available }
    })));
    if (redundantCustomIds.length) await tx.customSlot.deleteMany({ where: { id: { in: redundantCustomIds } } });
    if (biweeklyOverrides.length) await tx.biweeklySlot.createMany({
      data: biweeklyOverrides.map(row => ({ userId, groupId: null, parity: row.parity, day: row.day, slot: row.slot, available: row.available }))
    });
  });
  res.json({ slots: flatten(await getStandard(userId)) });
}));
app.get("/api/schedule/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId: req.session.userId!, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } }, include: { slots: true } });
  res.json({ weekStart, hasCustom: !!custom, slots: flatten(await getCustomWeek(req.session.userId!, weekStart)) });
}));
app.put("/api/schedule/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart;
  if (typeof weekStart !== "string") return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const parsed = slotsSchema.safeParse(req.body.slots);
  if (!parsed.success || parsed.data.length !== 672) return res.status(400).json({ error: "Send all 672 slots." });
  const userId = req.session.userId!;
  const standard = await getStandard(req.session.userId!);
  const custom = await prisma.customWeek.upsert({
    where: { userId_weekStart: { userId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } },
    create: { userId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) },
    update: {}
  });
  await prisma.$transaction([
    prisma.customSlot.deleteMany({ where: { customWeekId: custom.id } }),
    prisma.customSlot.createMany({ data: parsed.data.filter(s => standard[s.day][s.slot] !== s.available).map(s => ({ customWeekId: custom.id, ...s })) })
  ]);
  res.json({ weekStart, hasCustom: true, slots: flatten(await getCustomWeek(userId, weekStart)) });
}));
app.delete("/api/schedule/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId: req.session.userId!, weekStart: monday(weekStart) } }, select: { id: true } });
  if (custom) await prisma.customWeek.delete({ where: { id: custom.id } });
  res.status(204).end();
}));
app.get("/api/schedule/layers/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const groups = await prisma.plannerGroup.findMany({ where: participantWhere(req.session.userId!), select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } });
  res.json({ everyone: flatten(await getEffectiveWeek(req.session.userId!, weekStart)), groups: await groupLayerPayload(req.session.userId!, groups, weekStart) });
}));
app.get("/api/schedule/biweekly/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const user = await prisma.user.findUnique({ where: { id: req.session.userId! }, select: { biweeklyAnchorWeekStart: true } });
  const groups = await prisma.plannerGroup.findMany({ where: participantWhere(req.session.userId!), select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } });
  res.json({ weekStart, anchorWeekStart: user?.biweeklyAnchorWeekStart?.toISOString().slice(0, 10) || null, everyone: flatten(await getBiweeklyWeek(req.session.userId!, weekStart)), groups: await groupLayerPayload(req.session.userId!, groups, weekStart) });
}));
app.put("/api/schedule/biweekly/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const parsed = z.object({ everyone: slotsSchema, groups: z.array(z.object({ groupId: z.string().min(1), slots: slotsSchema })).max(100) }).safeParse(req.body);
  if (!parsed.success || parsed.data.everyone.length !== 672 || parsed.data.groups.some(g => g.slots.length !== 672)) return res.status(400).json({ error: "Send all 672 slots for everyone and each group." });
  const groupIds = parsed.data.groups.map(g => g.groupId);
  if (new Set(groupIds).size !== groupIds.length) return res.status(400).json({ error: "Each group can appear only once." });
  const userId = req.session.userId!;
  const groups = await prisma.plannerGroup.findMany({ where: { id: { in: groupIds }, ownerId: userId }, select: { id: true } });
  if (groups.length !== groupIds.length) return res.status(404).json({ error: "A group was not found or you are not its owner." });
  if (await hasConflictingGroupAssignments(parsed.data.groups)) return res.status(409).json({ error: "A member cannot be assigned to more than one group at the same time." });
  const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { biweeklyAnchorWeekStart: true } });
  const anchor = currentUser?.biweeklyAnchorWeekStart || monday(weekStart);
  const parity = weekParity(weekStart, anchor);
  const standard = await getStandard(userId);
  for (const group of parsed.data.groups) {
    const existing = await prisma.groupBiweeklySchedule.findUnique({ where: { groupId_parity: { groupId: group.groupId, parity } }, include: { slots: true } });
    const previous = new Set(existing?.slots.map(slot => `${slot.day}:${slot.slot}`) || []);
    const assigned = group.slots.filter(slot => slot.available && !previous.has(`${slot.day}:${slot.slot}`));
    if (await hasGroupAssignmentConflict(group.groupId, assigned, weekStart, groupIds)) return res.status(409).json({ error: "One or more selected times are already reserved for another group." });
  }
  await prisma.$transaction(async tx => {
    if (!currentUser?.biweeklyAnchorWeekStart) await tx.user.update({ where: { id: userId }, data: { biweeklyAnchorWeekStart: anchor } });
    await tx.biweeklySlot.deleteMany({ where: { userId, groupId: null, parity } });
    const personalOverrides = parsed.data.everyone.filter(slot => slot.available !== standard[slot.day][slot.slot]);
    if (personalOverrides.length) await tx.biweeklySlot.createMany({ data: personalOverrides.map(({ day, slot, available }) => ({ userId, parity, day, slot, available, groupId: null })) });
    for (const group of parsed.data.groups) {
      const schedule = await tx.groupBiweeklySchedule.upsert({
        where: { groupId_parity: { groupId: group.groupId, parity } },
        create: { groupId: group.groupId, parity },
        update: {}
      });
      await tx.groupBiweeklySlot.deleteMany({ where: { scheduleId: schedule.id } });
      await tx.groupBiweeklySlot.createMany({ data: group.slots.filter(slot => slot.available).map(slot => ({ scheduleId: schedule.id, day: slot.day, slot: slot.slot })) });
    }
  });
  res.json({ weekStart, anchorWeekStart: anchor.toISOString().slice(0, 10), parity });
}));
app.delete("/api/schedule/biweekly/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const userId = req.session.userId!;
  const parsed = z.object({ groupId: z.string().min(1).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid schedule target." });
  if (parsed.data.groupId) {
    const group = await prisma.plannerGroup.findFirst({ where: { id: parsed.data.groupId, ownerId: userId }, select: { id: true } });
    if (!group) return res.status(404).json({ error: "Group not found or you are not its owner." });
    await prisma.$transaction([
      prisma.groupBiweeklySchedule.deleteMany({ where: { groupId: group.id } }),
      prisma.biweeklySlot.deleteMany({ where: { userId, groupId: group.id } })
    ]);
  } else {
    await prisma.biweeklySlot.deleteMany({ where: { userId, groupId: null } });
  }
  res.status(204).end();
}));
app.get("/api/schedule/group/:groupId/standard", requireAuth, asyncRoute(async (req, res) => {
  const groupId = req.params.groupId;
  if (typeof groupId !== "string" || !(await isParticipant(req.session.userId!, groupId))) return res.status(404).json({ error: "Group not found." });
  const [layers, reservations] = await Promise.all([
    getGroupLayers(req.session.userId!, [groupId]),
    getAllGroupAssignmentLayers([groupId])
  ]);
  res.json({ slots: flatten(layers.get(groupId)!), locked: flatten(reservations.get(groupId)!) });
}));
app.put("/api/schedule/group/:groupId/standard", requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId!, groupId = req.params.groupId;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found." });
  const group = await prisma.plannerGroup.findFirst({ where: { id: groupId, ownerId: userId }, select: { id: true } });
  if (!group) return res.status(404).json({ error: "Group not found or you are not its owner." });
  const parsed = slotsSchema.safeParse(req.body.slots);
  if (!parsed.success || parsed.data.length !== 672) return res.status(400).json({ error: "Send all 672 weekly slots." });
  const assigned = parsed.data.filter(s => s.available).map(({ day, slot }) => ({ day, slot }));
  const previous = (await getGroupLayers(userId, [groupId])).get(groupId)!;
  const newlyAssigned = assigned.filter(slot => !previous[slot.day][slot.slot]);
  if (await hasGroupAssignmentConflict(groupId, newlyAssigned) || await hasGroupAssignmentConflict(groupId, newlyAssigned, currentWeekStart())) return res.status(409).json({ error: "One or more selected times are already reserved for another group." });
  await prisma.$transaction([
    prisma.groupStandardSlot.deleteMany({ where: { userId, groupId } }),
    prisma.groupStandardSlot.createMany({ data: assigned.map(({ day, slot }) => ({ userId, groupId, day, slot })) })
  ]);
  const layers = await getGroupLayers(userId, [groupId]);
  res.json({ slots: flatten(layers.get(groupId)!) });
}));
app.put("/api/schedule/group/:groupId/biweekly/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId!, groupId = req.params.groupId, weekStart = req.params.weekStart;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found." });
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const group = await prisma.plannerGroup.findFirst({ where: { id: groupId, ownerId: userId }, select: { id: true } });
  if (!group) return res.status(404).json({ error: "Group not found or you are not its owner." });
  const parsed = slotsSchema.safeParse(req.body.slots);
  if (!parsed.success || parsed.data.length !== 672) return res.status(400).json({ error: "Send all 672 alternating-week slots." });
  const current = (await getGroupLayers(userId, [groupId], weekStart, false, true)).get(groupId)!;
  const assigned = parsed.data.filter(slot => slot.available && !current[slot.day][slot.slot]);
  if (await hasGroupAssignmentConflict(groupId, assigned, weekStart)) return res.status(409).json({ error: "One or more selected times are already reserved for another group." });
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { biweeklyAnchorWeekStart: true } });
  const anchor = owner?.biweeklyAnchorWeekStart || monday(weekStart);
  const parity = weekParity(weekStart, anchor);
  await prisma.$transaction(async tx => {
    if (!owner?.biweeklyAnchorWeekStart) await tx.user.update({ where: { id: userId }, data: { biweeklyAnchorWeekStart: anchor } });
    const schedule = await tx.groupBiweeklySchedule.upsert({
      where: { groupId_parity: { groupId, parity } },
      create: { groupId, parity },
      update: {}
    });
    await tx.groupBiweeklySlot.deleteMany({ where: { scheduleId: schedule.id } });
    await tx.groupBiweeklySlot.createMany({ data: parsed.data.filter(slot => slot.available).map(slot => ({ scheduleId: schedule.id, day: slot.day, slot: slot.slot })) });
  });
  res.status(204).end();
}));
app.get("/api/schedule/group/:groupId/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const groupId = req.params.groupId, weekStart = req.params.weekStart;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  if (typeof groupId !== "string" || !(await isParticipant(req.session.userId!, groupId))) return res.status(404).json({ error: "Group not found." });
  const layers = await getGroupLayers(req.session.userId!, [groupId], weekStart, true, false);
  res.json({ weekStart, slots: flatten(layers.get(groupId)!) });
}));
app.put("/api/schedule/group/:groupId/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId!, groupId = req.params.groupId, weekStart = req.params.weekStart;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found." });
  if (typeof weekStart !== "string") return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const group = await prisma.plannerGroup.findFirst({ where: { id: groupId, ownerId: userId }, select: { id: true } });
  if (!group) return res.status(404).json({ error: "Group not found or you are not its owner." });
  const parsed = slotsSchema.safeParse(req.body.slots);
  if (!parsed.success || parsed.data.length !== 672) return res.status(400).json({ error: "Send all 672 slots." });
  const standard = (await getGroupLayers(userId, [groupId], weekStart, false, false)).get(groupId)!;
  const current = (await getGroupLayers(userId, [groupId], weekStart, true, false)).get(groupId)!;
  const assigned = parsed.data.filter(s => s.available).map(({ day, slot }) => ({ day, slot }));
  const newlyAssigned = assigned.filter(slot => !current[slot.day][slot.slot]);
  if (await hasGroupAssignmentConflict(groupId, newlyAssigned, weekStart)) return res.status(409).json({ error: "One or more selected times are already reserved for another group." });
  await prisma.$transaction([
    prisma.groupCustomSlot.deleteMany({ where: { userId, groupId, weekStart: monday(weekStart) } }),
    prisma.groupCustomSlot.createMany({ data: parsed.data.filter(s => standard[s.day][s.slot] !== s.available).map(s => ({ userId, groupId, weekStart: monday(weekStart), day: s.day, slot: s.slot, available: s.available })) })
  ]);
  const layers = await getGroupLayers(userId, [groupId], weekStart, true, false);
  res.json({ weekStart, slots: flatten(layers.get(groupId)!) });
}));
app.delete("/api/schedule/group/:groupId/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId!, groupId = req.params.groupId, weekStart = req.params.weekStart;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found." });
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
  const group = await prisma.plannerGroup.findFirst({ where: { id: groupId, ownerId: userId }, select: { id: true } });
  if (!group) return res.status(404).json({ error: "Group not found or you are not its owner." });
  await prisma.groupCustomSlot.deleteMany({ where: { userId, groupId, weekStart: monday(weekStart) } });
  res.status(204).end();
}));
app.get("/api/users/:username/schedule/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const weekStart = req.params.weekStart, username = req.params.username;
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday." });
  if (typeof username !== "string") return res.status(400).json({ error: "Enter a valid username." });
  const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, username: true } });
  if (!user) return res.status(404).json({ error: "User not found." });
  const standard = await getStandard(user.id);
  const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId: user.id, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } } });
  const groups = await prisma.plannerGroup.findMany({ where: participantWhere(user.id), select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } });
  res.json({ user: { username: user.username }, standard: flatten(standard), custom: flatten(await getEffectiveWeek(user.id, weekStart)), hasCustom: !!custom, groups: await groupLayerPayload(user.id, groups, weekStart) });
}));

app.get("/api/groups", requireAuth, asyncRoute(async (req, res) => {
  const groups = await prisma.plannerGroup.findMany({ where: { OR: [{ ownerId: req.session.userId! }, { members: { some: { userId: req.session.userId! } } }] }, include: { members: { include: { user: { select: { id: true, username: true } } } }, owner: { select: { id: true, username: true } } }, orderBy: { createdAt: "desc" } });
  res.json({ groups: groups.map(g => ({ id: g.id, name: g.name, color: g.color, owner: g.owner, members: g.members.map(m => m.user) })) });
}));
app.post("/api/groups", requireAuth, asyncRoute(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Group name must be 1–60 characters." });
  const group = await prisma.plannerGroup.create({ data: { name: parsed.data.name, color: await pickGroupColor(), ownerId: req.session.userId! } });
  res.status(201).json({ group: { id: group.id, name: group.name, color: group.color } });
}));
app.delete("/api/groups/:id", requireAuth, asyncRoute(async (req, res) => {
  const groupId = req.params.id;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found or you are not its owner." });
  const group = await prisma.plannerGroup.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== req.session.userId) return res.status(404).json({ error: "Group not found or you are not its owner." });
  await prisma.plannerGroup.delete({ where: { id: group.id } });
  res.status(204).end();
}));
app.patch("/api/groups/:id", requireAuth, asyncRoute(async (req, res) => {
  const groupId = req.params.id;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found or you are not its owner." });
  const parsed = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid group color." });
  const group = await prisma.plannerGroup.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== req.session.userId) return res.status(404).json({ error: "Group not found or you are not its owner." });
  const updated = await prisma.plannerGroup.update({ where: { id: group.id }, data: { color: parsed.data.color } });
  res.json({ group: { id: updated.id, name: updated.name, color: updated.color } });
}));
app.post("/api/groups/:id/members", requireAuth, asyncRoute(async (req, res) => {
  const groupId = req.params.id;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found or you are not its owner." });
  const parsed = z.object({ username: usernameSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid username." });
  const group = await prisma.plannerGroup.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== req.session.userId) return res.status(404).json({ error: "Group not found or you are not its owner." });
  const user = await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });
  if (!user) return res.status(404).json({ error: "User not found." });
  await prisma.groupMember.upsert({ where: { groupId_userId: { groupId: group.id, userId: user.id } }, create: { groupId: group.id, userId: user.id }, update: {} });
  res.status(201).json({ message: "Member added." });
}));
app.delete("/api/groups/:id/members/:userId", requireAuth, asyncRoute(async (req, res) => {
  const groupId = req.params.id, memberId = req.params.userId;
  if (typeof groupId !== "string" || typeof memberId !== "string") return res.status(404).json({ error: "Group not found or you are not allowed to remove this member." });
  const group = await prisma.plannerGroup.findUnique({ where: { id: groupId } });
  const isOwner = group?.ownerId === req.session.userId;
  const leavingSelf = memberId === req.session.userId;
  if (!group || (!isOwner && !leavingSelf)) return res.status(404).json({ error: "Group not found or you are not allowed to remove this member." });
  await prisma.$transaction([
    prisma.groupMember.deleteMany({ where: { groupId: group.id, userId: memberId } }),
    prisma.groupStandardSlot.deleteMany({ where: { groupId: group.id, userId: memberId } }),
    prisma.groupCustomSlot.deleteMany({ where: { groupId: group.id, userId: memberId } })
  ]);
  res.status(204).end();
}));
app.get("/api/groups/:id/schedule/:weekStart", requireAuth, asyncRoute(async (req, res) => {
  const groupId = req.params.id, weekStart = req.params.weekStart;
  if (typeof groupId !== "string") return res.status(404).json({ error: "Group not found." });
  if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday." });
  const group = await prisma.plannerGroup.findFirst({
    where: { id: groupId, OR: [{ ownerId: req.session.userId! }, { members: { some: { userId: req.session.userId! } } }] },
    include: { owner: { select: { id: true, username: true } }, members: { include: { user: { select: { id: true, username: true } } } } }
  });
  if (!group) return res.status(404).json({ error: "Group not found." });
  const users = [group.owner, ...group.members.map(m => m.user)].filter((u, i, a) => a.findIndex(v => v.id === u.id) === i);
  const userIds = users.map(user => user.id);
  const participantGroups = await prisma.plannerGroup.findMany({
    where: { OR: [{ ownerId: { in: userIds } }, { members: { some: { userId: { in: userIds } } } }] },
    select: { id: true, ownerId: true, members: { select: { userId: true } } }
  });
  const grids = await Promise.all(users.map(async u => {
    const everyone = await getEffectiveWeek(u.id, weekStart);
    const grid = everyone.map(row => [...row]);
    const groupIds = participantGroups
      .filter(participantGroup => participantGroup.ownerId === u.id || participantGroup.members.some(member => member.userId === u.id))
      .map(participantGroup => participantGroup.id);
    const layers = await getGroupLayers(u.id, groupIds, weekStart);
    const selectedGroupLayer = layers.get(group.id) ?? emptyGrid();
    for (const [assignedGroupId, layer] of layers) if (assignedGroupId !== group.id) {
      for (let d = 0; d < 7; d++) for (let s = 0; s < 96; s++) if (layer[d][s]) grid[d][s] = false;
    }
    for (let d = 0; d < 7; d++) for (let s = 0; s < 96; s++) if (selectedGroupLayer[d][s]) grid[d][s] = true;
    return { username: u.username, grid, groupOnly: selectedGroupLayer };
  }));
  const slots = Array.from({ length: 672 }, (_, i) => {
    const day = Math.floor(i / 96), slot = i % 96;
    const unavailable = grids.filter(g => !g.grid[day][slot]).map(g => g.username);
    const available = grids.length - unavailable.length;
    const status = available === grids.length ? "green" : unavailable.length === 1 ? "yellow" : "red";
    const groupOnly = grids.some(g => g.groupOnly[day][slot]);
    return { day, slot, status, unavailable, groupOnly };
  });
  res.json({ group: { id: group.id, name: group.name, color: group.color }, members: grids.map(g => g.username), slots });
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "An unexpected server error occurred." });
});
app.listen(port, () => console.log(`Availability Planner API listening on http://localhost:${port}`));
