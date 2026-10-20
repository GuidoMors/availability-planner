import "dotenv/config";
import express from "express";
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
function asyncRoute(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function requireAuth(req, res, next) {
    if (!req.session.userId)
        return res.status(401).json({ error: "Please log in." });
    next();
}
const usernameSchema = z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/, "Use letters, numbers, and underscores only.");
const slotsSchema = z.array(z.object({ day: z.number().int().min(0).max(6), slot: z.number().int().min(0).max(95), available: z.boolean() })).max(672);
const weekSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const validWeekStart = (s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.getUTCDay() === 1 && d.toISOString().slice(0, 10) === s;
};
const weekParity = (weekStart, anchor) => ((Math.floor((monday(weekStart).getTime() - anchor.getTime()) / 604800000) % 2) + 2) % 2;
async function getStandard(userId) {
    const rows = await prisma.standardSlot.findMany({ where: { userId } });
    const grid = Array.from({ length: 7 }, () => Array(96).fill(false));
    for (const r of rows)
        grid[r.day][r.slot] = r.available;
    return grid;
}
async function getEffectiveWeek(userId, weekStart) {
    const grid = await getStandard(userId);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { biweeklyAnchorWeekStart: true } });
    if (user?.biweeklyAnchorWeekStart) {
        const biweekly = await prisma.biweeklySlot.findMany({ where: { userId, parity: weekParity(weekStart, user.biweeklyAnchorWeekStart) } });
        if (biweekly.length) {
            for (const row of biweekly)
                grid[row.day][row.slot] = row.groupId === null && row.available;
        }
    }
    const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } }, include: { slots: true } });
    if (custom)
        for (const s of custom.slots)
            grid[s.day][s.slot] = s.available;
    return grid;
}
function flatten(grid) {
    return grid.flatMap((day, d) => day.map((available, slot) => ({ day: d, slot, available })));
}
const GROUP_COLORS = ["#5667df", "#e0569b", "#9b5de5", "#1ea5d8", "#d97706", "#c026d3", "#2563eb", "#be123c", "#7c4a2d", "#64748b"];
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, "0");
    return `#${f(0)}${f(8)}${f(4)}`;
}
async function pickGroupColor() {
    const used = new Set((await prisma.plannerGroup.findMany({ select: { color: true } })).map(g => g.color.toLowerCase()));
    const free = GROUP_COLORS.find(c => !used.has(c));
    if (free)
        return free;
    // Palette exhausted: generate more distinct hues, skipping the green range reserved for "everyone".
    for (let n = used.size; n < used.size + 1000; n++) {
        let hue = (n * 137.508) % 360;
        if (hue >= 110 && hue <= 190)
            hue += 90;
        const c = hslToHex(hue % 360, 62, 48);
        if (!used.has(c))
            return c;
    }
    return GROUP_COLORS[0];
}
const monday = (weekStart) => new Date(`${weekStart}T00:00:00.000Z`);
const participantWhere = (userId) => ({ OR: [{ ownerId: userId }, { members: { some: { userId } } }] });
async function isParticipant(userId, groupId) {
    return !!(await prisma.plannerGroup.findFirst({ where: { id: groupId, ...participantWhere(userId) }, select: { id: true } }));
}
const emptyGrid = () => Array.from({ length: 7 }, () => Array(96).fill(false));
/** Group-only availability ("available for this group only") per group, effective for one week. */
async function getGroupLayers(userId, groupIds, weekStart) {
    const layers = new Map(groupIds.map(id => [id, emptyGrid()]));
    if (!groupIds.length)
        return layers;
    const standard = await prisma.groupStandardSlot.findMany({ where: { userId, groupId: { in: groupIds } } });
    for (const r of standard)
        layers.get(r.groupId)[r.day][r.slot] = true;
    if (weekStart) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { biweeklyAnchorWeekStart: true } });
        if (user?.biweeklyAnchorWeekStart) {
            const biweekly = await prisma.biweeklySlot.findMany({ where: { userId, parity: weekParity(weekStart, user.biweeklyAnchorWeekStart) } });
            if (biweekly.length) {
                for (const grid of layers.values())
                    for (const row of grid)
                        row.fill(false);
                for (const row of biweekly)
                    if (row.groupId && row.available && layers.has(row.groupId))
                        layers.get(row.groupId)[row.day][row.slot] = true;
            }
        }
        const custom = await prisma.groupCustomSlot.findMany({ where: { userId, groupId: { in: groupIds }, weekStart: monday(weekStart) } });
        for (const r of custom)
            layers.get(r.groupId)[r.day][r.slot] = r.available;
    }
    return layers;
}
async function groupLayerPayload(userId, groups, weekStart) {
    const layers = await getGroupLayers(userId, groups.map(g => g.id), weekStart);
    return groups.map(g => ({ id: g.id, name: g.name, color: g.color, slots: flatten(layers.get(g.id)) }));
}
async function sendResetEmail(to, url) {
    const host = process.env.SMTP_HOST;
    if (!host) {
        if (isProduction)
            throw new Error("Email delivery is not configured.");
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
    if (!parsed.success)
        return res.status(400).json({ error: "Username must be 3–24 letters/numbers/underscores; password must be 12–128 characters." });
    const username = parsed.data.username.toLowerCase();
    const email = parsed.data.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { username } }))
        return res.status(409).json({ error: "Username is already taken." });
    if (await prisma.user.findUnique({ where: { email } }))
        return res.status(409).json({ error: "Email is already registered." });
    const user = await prisma.user.create({ data: { username, email, passwordHash: await argon2.hash(parsed.data.password, { type: argon2.argon2id }) } });
    await prisma.standardSlot.createMany({ data: Array.from({ length: 672 }, (_, i) => ({ userId: user.id, day: Math.floor(i / 96), slot: i % 96, available: false })) });
    req.session.userId = user.id;
    res.status(201).json({ user: { id: user.id, username: user.username } });
}));
app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
    const parsed = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(128) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: "Enter username and password." });
    const user = await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });
    if (!user || !(await argon2.verify(user.passwordHash, parsed.data.password)))
        return res.status(401).json({ error: "Invalid username or password." });
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = user.id;
    res.json({ user: { id: user.id, username: user.username } });
}));
app.post("/api/auth/logout", requireAuth, (req, res) => req.session.destroy(() => { res.clearCookie("availability.sid"); res.status(204).end(); }));
app.get("/api/auth/me", asyncRoute(async (req, res) => {
    if (!req.session.userId)
        return res.json({ user: null });
    const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, username: true } });
    res.json({ user });
}));
app.post("/api/auth/forgot-password", resetLimiter, asyncRoute(async (req, res) => {
    const parsed = z.object({ email: z.string().trim().email().max(254) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(200).json({ message: "If that account exists, recovery instructions will be sent." });
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
    if (user) {
        const rawToken = crypto.randomBytes(32).toString("base64url");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
        try {
            await sendResetEmail(user.email, `${appUrl}/reset-password?token=${rawToken}`);
        }
        catch (e) {
            console.error("Reset email delivery failed", e);
        }
    }
    res.json({ message: "If that account exists, recovery instructions will be sent." });
}));
app.post("/api/auth/reset-password", resetLimiter, asyncRoute(async (req, res) => {
    const parsed = z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(128) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: "Invalid token or password. Passwords must be at least 12 characters." });
    const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!record || record.usedAt || record.expiresAt < new Date())
        return res.status(400).json({ error: "Reset link is invalid or expired." });
    await prisma.$transaction([
        prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await argon2.hash(parsed.data.password, { type: argon2.argon2id }) } }),
        prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
        prisma.passwordResetToken.updateMany({ where: { userId: record.userId, id: { not: record.id }, usedAt: null }, data: { usedAt: new Date() } })
    ]);
    res.json({ message: "Password updated. You can now log in." });
}));
app.get("/api/schedule/standard", requireAuth, asyncRoute(async (req, res) => res.json({ slots: flatten(await getStandard(req.session.userId)) })));
app.put("/api/schedule/standard", requireAuth, asyncRoute(async (req, res) => {
    const parsed = slotsSchema.safeParse(req.body.slots);
    if (!parsed.success || parsed.data.length !== 672)
        return res.status(400).json({ error: "Send all 672 weekly slots." });
    const userId = req.session.userId;
    const assigned = parsed.data.filter(s => s.available).map(({ day, slot }) => ({ day, slot }));
    await prisma.$transaction([
        ...parsed.data.map(s => prisma.standardSlot.update({ where: { userId_day_slot: { userId, day: s.day, slot: s.slot } }, data: { available: s.available } })),
        ...(assigned.length ? [
            prisma.groupStandardSlot.deleteMany({ where: { userId, OR: assigned } }),
            prisma.groupCustomSlot.deleteMany({ where: { userId, available: true, OR: assigned } }),
            prisma.customSlot.deleteMany({ where: { available: true, customWeek: { userId }, OR: assigned } })
        ] : [])
    ]);
    res.json({ slots: flatten(await getStandard(userId)) });
}));
app.get("/api/schedule/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    if (!weekSchema.safeParse(req.params.weekStart).success || !validWeekStart(req.params.weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    const weekStart = req.params.weekStart;
    const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId: req.session.userId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } }, include: { slots: true } });
    res.json({ weekStart, hasCustom: !!custom, slots: flatten(await getEffectiveWeek(req.session.userId, weekStart)) });
}));
app.put("/api/schedule/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const weekStart = req.params.weekStart;
    if (typeof weekStart !== "string")
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    const parsed = slotsSchema.safeParse(req.body.slots);
    if (!parsed.success || parsed.data.length !== 672)
        return res.status(400).json({ error: "Send all 672 slots." });
    const standard = await getStandard(req.session.userId);
    const custom = await prisma.customWeek.upsert({
        where: { userId_weekStart: { userId: req.session.userId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } },
        create: { userId: req.session.userId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) },
        update: {}
    });
    const userId = req.session.userId;
    const assigned = parsed.data.filter(s => s.available).map(({ day, slot }) => ({ day, slot }));
    let groupStandard = [];
    let groupOverrides = [];
    if (assigned.length)
        [groupStandard, groupOverrides] = await Promise.all([
            prisma.groupStandardSlot.findMany({ where: { userId, OR: assigned }, select: { groupId: true, day: true, slot: true } }),
            prisma.groupCustomSlot.findMany({ where: { userId, weekStart: monday(weekStart), OR: assigned }, select: { groupId: true, day: true, slot: true, available: true } })
        ]);
    const groupOverrideKeys = new Set(groupOverrides.map(s => `${s.groupId}:${s.day}:${s.slot}`));
    const groupOverridesToClear = groupOverrides.filter(s => s.available);
    const missingGroupOverrides = groupStandard.filter(s => !groupOverrideKeys.has(`${s.groupId}:${s.day}:${s.slot}`));
    await prisma.$transaction([
        prisma.customSlot.deleteMany({ where: { customWeekId: custom.id } }),
        prisma.customSlot.createMany({ data: parsed.data.filter(s => standard[s.day][s.slot] !== s.available).map(s => ({ customWeekId: custom.id, ...s })) }),
        ...(groupOverridesToClear.length ? [prisma.groupCustomSlot.updateMany({ where: { userId, weekStart: monday(weekStart), available: true, OR: groupOverridesToClear.map(({ groupId, day, slot }) => ({ groupId, day, slot })) }, data: { available: false } })] : []),
        ...(missingGroupOverrides.length ? [prisma.groupCustomSlot.createMany({ data: missingGroupOverrides.map(({ groupId, day, slot }) => ({ userId, groupId, weekStart: monday(weekStart), day, slot, available: false })) })] : [])
    ]);
    res.json({ weekStart, hasCustom: true, slots: flatten(await getEffectiveWeek(req.session.userId, weekStart)) });
}));
app.get("/api/schedule/layers/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const weekStart = req.params.weekStart;
    if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    const groups = await prisma.plannerGroup.findMany({ where: participantWhere(req.session.userId), select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } });
    res.json({ everyone: flatten(await getEffectiveWeek(req.session.userId, weekStart)), groups: await groupLayerPayload(req.session.userId, groups, weekStart) });
}));
app.get("/api/schedule/biweekly/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const weekStart = req.params.weekStart;
    if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { biweeklyAnchorWeekStart: true } });
    const groups = await prisma.plannerGroup.findMany({ where: participantWhere(req.session.userId), select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } });
    res.json({ weekStart, anchorWeekStart: user?.biweeklyAnchorWeekStart?.toISOString().slice(0, 10) || null, everyone: flatten(await getEffectiveWeek(req.session.userId, weekStart)), groups: await groupLayerPayload(req.session.userId, groups, weekStart) });
}));
app.put("/api/schedule/biweekly/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const weekStart = req.params.weekStart;
    if (typeof weekStart !== "string" || !weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    const parsed = z.object({ everyone: slotsSchema, groups: z.array(z.object({ groupId: z.string().min(1), slots: slotsSchema })).max(100) }).safeParse(req.body);
    if (!parsed.success || parsed.data.everyone.length !== 672 || parsed.data.groups.some(g => g.slots.length !== 672))
        return res.status(400).json({ error: "Send all 672 slots for everyone and each group." });
    const groupIds = parsed.data.groups.map(g => g.groupId);
    if (new Set(groupIds).size !== groupIds.length)
        return res.status(400).json({ error: "Each group can appear only once." });
    const userId = req.session.userId;
    const groups = await prisma.plannerGroup.findMany({ where: { ...participantWhere(userId), id: { in: groupIds } }, select: { id: true } });
    if (groups.length !== groupIds.length)
        return res.status(404).json({ error: "A group was not found." });
    const audiences = new Map();
    for (const slot of parsed.data.everyone)
        if (slot.available)
            audiences.set(`${slot.day}:${slot.slot}`, null);
    for (const group of parsed.data.groups)
        for (const slot of group.slots)
            if (slot.available) {
                const key = `${slot.day}:${slot.slot}`;
                if (audiences.has(key))
                    return res.status(400).json({ error: "Each time slot can be available to everyone or one group only." });
                audiences.set(key, group.groupId);
            }
    const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { biweeklyAnchorWeekStart: true } });
    const anchor = currentUser?.biweeklyAnchorWeekStart || monday(weekStart);
    const parity = weekParity(weekStart, anchor);
    const allSlots = parsed.data.everyone.map(({ day, slot }) => {
        const groupId = audiences.get(`${day}:${slot}`) ?? null;
        return { userId, parity, day, slot, available: audiences.has(`${day}:${slot}`), groupId };
    });
    await prisma.$transaction([
        ...(!currentUser?.biweeklyAnchorWeekStart ? [prisma.user.update({ where: { id: userId }, data: { biweeklyAnchorWeekStart: anchor } })] : []),
        prisma.customWeek.deleteMany({ where: { userId, weekStart: monday(weekStart) } }),
        prisma.groupCustomSlot.deleteMany({ where: { userId, weekStart: monday(weekStart) } }),
        prisma.biweeklySlot.deleteMany({ where: { userId, parity } }),
        prisma.biweeklySlot.createMany({ data: allSlots })
    ]);
    res.json({ weekStart, anchorWeekStart: anchor.toISOString().slice(0, 10), parity });
}));
app.get("/api/schedule/group/:groupId/standard", requireAuth, asyncRoute(async (req, res) => {
    if (!(await isParticipant(req.session.userId, req.params.groupId)))
        return res.status(404).json({ error: "Group not found." });
    const layers = await getGroupLayers(req.session.userId, [req.params.groupId]);
    res.json({ slots: flatten(layers.get(req.params.groupId)) });
}));
app.put("/api/schedule/group/:groupId/standard", requireAuth, asyncRoute(async (req, res) => {
    const userId = req.session.userId, groupId = req.params.groupId;
    if (typeof groupId !== "string")
        return res.status(404).json({ error: "Group not found." });
    if (!(await isParticipant(userId, groupId)))
        return res.status(404).json({ error: "Group not found." });
    const parsed = slotsSchema.safeParse(req.body.slots);
    if (!parsed.success || parsed.data.length !== 672)
        return res.status(400).json({ error: "Send all 672 weekly slots." });
    const assigned = parsed.data.filter(s => s.available).map(({ day, slot }) => ({ day, slot }));
    await prisma.$transaction([
        prisma.groupStandardSlot.deleteMany({ where: { userId, groupId } }),
        prisma.groupStandardSlot.createMany({ data: parsed.data.filter(s => s.available).map(s => ({ userId, groupId, day: s.day, slot: s.slot })) }),
        ...(assigned.length ? [
            prisma.standardSlot.updateMany({ where: { userId, available: true, OR: assigned }, data: { available: false } }),
            prisma.groupCustomSlot.deleteMany({ where: { userId, groupId: { not: groupId }, available: true, OR: assigned } }),
            prisma.customSlot.deleteMany({ where: { available: true, customWeek: { userId }, OR: assigned } })
        ] : []),
        ...(assigned.length ? [
            prisma.groupStandardSlot.deleteMany({ where: { userId, groupId: { not: groupId }, OR: assigned } })
        ] : [])
    ]);
    const layers = await getGroupLayers(userId, [groupId]);
    res.json({ slots: flatten(layers.get(groupId)) });
}));
app.get("/api/schedule/group/:groupId/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const weekStart = req.params.weekStart;
    if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    if (!(await isParticipant(req.session.userId, req.params.groupId)))
        return res.status(404).json({ error: "Group not found." });
    const layers = await getGroupLayers(req.session.userId, [req.params.groupId], weekStart);
    res.json({ weekStart, slots: flatten(layers.get(req.params.groupId)) });
}));
app.put("/api/schedule/group/:groupId/custom/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const userId = req.session.userId, groupId = req.params.groupId, weekStart = req.params.weekStart;
    if (typeof groupId !== "string")
        return res.status(404).json({ error: "Group not found." });
    if (typeof weekStart !== "string")
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday in YYYY-MM-DD format." });
    if (!(await isParticipant(userId, groupId)))
        return res.status(404).json({ error: "Group not found." });
    const parsed = slotsSchema.safeParse(req.body.slots);
    if (!parsed.success || parsed.data.length !== 672)
        return res.status(400).json({ error: "Send all 672 slots." });
    const standard = (await getGroupLayers(userId, [groupId])).get(groupId);
    const assigned = parsed.data.filter(s => s.available).map(({ day, slot }) => ({ day, slot }));
    const otherGroupIds = (await prisma.plannerGroup.findMany({ where: participantWhere(userId), select: { id: true } })).map(g => g.id).filter(id => id !== groupId);
    const otherWhere = { userId, groupId: { in: otherGroupIds }, weekStart: monday(weekStart), OR: assigned };
    const customWeek = await prisma.customWeek.upsert({
        where: { userId_weekStart: { userId, weekStart: monday(weekStart) } },
        create: { userId, weekStart: monday(weekStart) },
        update: {}
    });
    let otherStandard = [];
    let otherOverrides = [];
    let publicStandard = [];
    let publicOverrides = [];
    if (assigned.length)
        [otherStandard, otherOverrides, publicStandard, publicOverrides] = await Promise.all([
            otherGroupIds.length ? prisma.groupStandardSlot.findMany({ where: { userId, groupId: { in: otherGroupIds }, OR: assigned }, select: { groupId: true, day: true, slot: true } }) : Promise.resolve([]),
            otherGroupIds.length ? prisma.groupCustomSlot.findMany({ where: otherWhere, select: { groupId: true, day: true, slot: true, available: true } }) : Promise.resolve([]),
            prisma.standardSlot.findMany({ where: { userId, available: true, OR: assigned }, select: { day: true, slot: true } }),
            prisma.customSlot.findMany({ where: { customWeekId: customWeek.id, OR: assigned }, select: { day: true, slot: true, available: true } })
        ]);
    const overrideKeys = new Set(otherOverrides.map(s => `${s.groupId}:${s.day}:${s.slot}`));
    const missingOverrides = otherStandard.filter(s => !overrideKeys.has(`${s.groupId}:${s.day}:${s.slot}`));
    const activeOverrides = otherOverrides.filter(s => s.available);
    const publicOverrideKeys = new Set(publicOverrides.map(s => `${s.day}:${s.slot}`));
    const publicOverridesToClear = publicOverrides.filter(s => s.available);
    const missingPublicOverrides = publicStandard.filter(s => !publicOverrideKeys.has(`${s.day}:${s.slot}`));
    await prisma.$transaction([
        prisma.groupCustomSlot.deleteMany({ where: { userId, groupId, weekStart: monday(weekStart) } }),
        prisma.groupCustomSlot.createMany({ data: parsed.data.filter(s => standard[s.day][s.slot] !== s.available).map(s => ({ userId, groupId, weekStart: monday(weekStart), day: s.day, slot: s.slot, available: s.available })) }),
        ...(activeOverrides.length ? [prisma.groupCustomSlot.updateMany({ where: { userId, weekStart: monday(weekStart), available: true, OR: activeOverrides.map(({ groupId: otherId, day, slot }) => ({ groupId: otherId, day, slot })) }, data: { available: false } })] : []),
        ...(missingOverrides.length ? [prisma.groupCustomSlot.createMany({ data: missingOverrides.map(({ groupId: otherId, day, slot }) => ({ userId, groupId: otherId, weekStart: monday(weekStart), day, slot, available: false })) })] : []),
        ...(publicOverridesToClear.length ? [prisma.customSlot.updateMany({ where: { customWeekId: customWeek.id, available: true, OR: publicOverridesToClear.map(({ day, slot }) => ({ day, slot })) }, data: { available: false } })] : []),
        ...(missingPublicOverrides.length ? [prisma.customSlot.createMany({ data: missingPublicOverrides.map(({ day, slot }) => ({ customWeekId: customWeek.id, day, slot, available: false })) })] : [])
    ]);
    const layers = await getGroupLayers(userId, [groupId], weekStart);
    res.json({ weekStart, slots: flatten(layers.get(groupId)) });
}));
app.get("/api/users/:username/schedule/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const weekStart = req.params.weekStart;
    if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday." });
    const user = await prisma.user.findUnique({ where: { username: req.params.username.toLowerCase() }, select: { id: true, username: true } });
    if (!user)
        return res.status(404).json({ error: "User not found." });
    const standard = await getStandard(user.id);
    const custom = await prisma.customWeek.findUnique({ where: { userId_weekStart: { userId: user.id, weekStart: new Date(`${weekStart}T00:00:00.000Z`) } } });
    // Only reveal group-only availability for groups the viewer and the profile owner both belong to.
    const shared = await prisma.plannerGroup.findMany({ where: { AND: [participantWhere(req.session.userId), participantWhere(user.id)] }, select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } });
    res.json({ user: { username: user.username }, standard: flatten(standard), custom: flatten(await getEffectiveWeek(user.id, weekStart)), hasCustom: !!custom, groups: await groupLayerPayload(user.id, shared, weekStart) });
}));
app.get("/api/groups", requireAuth, asyncRoute(async (req, res) => {
    const groups = await prisma.plannerGroup.findMany({ where: { OR: [{ ownerId: req.session.userId }, { members: { some: { userId: req.session.userId } } }] }, include: { members: { include: { user: { select: { id: true, username: true } } } }, owner: { select: { id: true, username: true } } }, orderBy: { createdAt: "desc" } });
    res.json({ groups: groups.map(g => ({ id: g.id, name: g.name, color: g.color, owner: g.owner, members: g.members.map(m => m.user) })) });
}));
app.post("/api/groups", requireAuth, asyncRoute(async (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: "Group name must be 1–60 characters." });
    const group = await prisma.plannerGroup.create({ data: { name: parsed.data.name, color: await pickGroupColor(), ownerId: req.session.userId } });
    res.status(201).json({ group: { id: group.id, name: group.name, color: group.color } });
}));
app.delete("/api/groups/:id", requireAuth, asyncRoute(async (req, res) => {
    const groupId = req.params.id;
    if (typeof groupId !== "string")
        return res.status(404).json({ error: "Group not found or you are not its owner." });
    const group = await prisma.plannerGroup.findUnique({ where: { id: groupId } });
    if (!group || group.ownerId !== req.session.userId)
        return res.status(404).json({ error: "Group not found or you are not its owner." });
    await prisma.plannerGroup.delete({ where: { id: group.id } });
    res.status(204).end();
}));
app.patch("/api/groups/:id", requireAuth, asyncRoute(async (req, res) => {
    const groupId = req.params.id;
    if (typeof groupId !== "string")
        return res.status(404).json({ error: "Group not found or you are not its owner." });
    const parsed = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: "Enter a valid group color." });
    const group = await prisma.plannerGroup.findUnique({ where: { id: groupId } });
    if (!group || group.ownerId !== req.session.userId)
        return res.status(404).json({ error: "Group not found or you are not its owner." });
    const updated = await prisma.plannerGroup.update({ where: { id: group.id }, data: { color: parsed.data.color } });
    res.json({ group: { id: updated.id, name: updated.name, color: updated.color } });
}));
app.post("/api/groups/:id/members", requireAuth, asyncRoute(async (req, res) => {
    const parsed = z.object({ username: usernameSchema }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: "Enter a valid username." });
    const group = await prisma.plannerGroup.findUnique({ where: { id: req.params.id } });
    if (!group || group.ownerId !== req.session.userId)
        return res.status(404).json({ error: "Group not found or you are not its owner." });
    const user = await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });
    if (!user)
        return res.status(404).json({ error: "User not found." });
    await prisma.groupMember.upsert({ where: { groupId_userId: { groupId: group.id, userId: user.id } }, create: { groupId: group.id, userId: user.id }, update: {} });
    res.status(201).json({ message: "Member added." });
}));
app.delete("/api/groups/:id/members/:userId", requireAuth, asyncRoute(async (req, res) => {
    const group = await prisma.plannerGroup.findUnique({ where: { id: req.params.id } });
    if (!group || group.ownerId !== req.session.userId)
        return res.status(404).json({ error: "Group not found or you are not its owner." });
    await prisma.$transaction([
        prisma.groupMember.deleteMany({ where: { groupId: group.id, userId: req.params.userId } }),
        prisma.groupStandardSlot.deleteMany({ where: { groupId: group.id, userId: req.params.userId } }),
        prisma.groupCustomSlot.deleteMany({ where: { groupId: group.id, userId: req.params.userId } })
    ]);
    res.status(204).end();
}));
app.get("/api/groups/:id/schedule/:weekStart", requireAuth, asyncRoute(async (req, res) => {
    const weekStart = req.params.weekStart;
    if (!weekSchema.safeParse(weekStart).success || !validWeekStart(weekStart))
        return res.status(400).json({ error: "weekStart must be a Monday." });
    const group = await prisma.plannerGroup.findFirst({
        where: { id: req.params.id, OR: [{ ownerId: req.session.userId }, { members: { some: { userId: req.session.userId } } }] },
        include: { owner: { select: { id: true, username: true } }, members: { include: { user: { select: { id: true, username: true } } } } }
    });
    if (!group)
        return res.status(404).json({ error: "Group not found." });
    const users = [group.owner, ...group.members.map(m => m.user)].filter((u, i, a) => a.findIndex(v => v.id === u.id) === i);
    // Only "everyone" availability plus this group's own group-only availability counts; other groups' slots are ignored.
    const grids = await Promise.all(users.map(async (u) => {
        const everyone = await getEffectiveWeek(u.id, weekStart);
        const grid = everyone.map(row => [...row]);
        const own = (await getGroupLayers(u.id, [group.id], weekStart)).get(group.id);
        for (let d = 0; d < 7; d++)
            for (let s = 0; s < 96; s++)
                if (own[d][s])
                    grid[d][s] = true;
        return { username: u.username, grid, groupOnly: own, isOwner: u.id === group.ownerId };
    }));
    const slots = Array.from({ length: 672 }, (_, i) => {
        const day = Math.floor(i / 96), slot = i % 96;
        const unavailable = grids.filter(g => !g.grid[day][slot]).map(g => g.username);
        const available = grids.length - unavailable.length;
        const status = available === grids.length ? "green" : unavailable.length === grids.length ? "red" : unavailable.length === 1 ? "yellow" : "orange";
        const groupOnly = grids.some(g => g.isOwner && g.groupOnly[day][slot]);
        return { day, slot, status, unavailable, groupOnly };
    });
    res.json({ group: { id: group.id, name: group.name, color: group.color }, members: grids.map(g => g.username), slots });
}));
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "An unexpected server error occurred." });
});
app.listen(port, () => console.log(`Availability Planner API listening on http://localhost:${port}`));
