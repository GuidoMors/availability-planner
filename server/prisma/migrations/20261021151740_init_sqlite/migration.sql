-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "biweeklyAnchorWeekStart" DATETIME
);

-- CreateTable
CREATE TABLE "StandardSlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "StandardSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CustomWeek" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "weekStart" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CustomWeek_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CustomSlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customWeekId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL,
    CONSTRAINT "CustomSlot_customWeekId_fkey" FOREIGN KEY ("customWeekId") REFERENCES "CustomWeek" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlannerGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#5667df',
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlannerGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupStandardSlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    CONSTRAINT "GroupStandardSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupStandardSlot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupCustomSlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "weekStart" DATETIME NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL,
    CONSTRAINT "GroupCustomSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupCustomSlot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupBiweeklySchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "parity" INTEGER NOT NULL,
    CONSTRAINT "GroupBiweeklySchedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupBiweeklySlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    CONSTRAINT "GroupBiweeklySlot_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "GroupBiweeklySchedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BiweeklySlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "groupId" TEXT,
    "parity" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL,
    CONSTRAINT "BiweeklySlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BiweeklySlot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "sid" TEXT NOT NULL PRIMARY KEY,
    "sess" TEXT NOT NULL,
    "expire" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "StandardSlot_userId_idx" ON "StandardSlot"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StandardSlot_userId_day_slot_key" ON "StandardSlot"("userId", "day", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "CustomWeek_userId_weekStart_key" ON "CustomWeek"("userId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "CustomSlot_customWeekId_day_slot_key" ON "CustomSlot"("customWeekId", "day", "slot");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "GroupStandardSlot_userId_groupId_idx" ON "GroupStandardSlot"("userId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupStandardSlot_userId_groupId_day_slot_key" ON "GroupStandardSlot"("userId", "groupId", "day", "slot");

-- CreateIndex
CREATE INDEX "GroupCustomSlot_userId_groupId_weekStart_idx" ON "GroupCustomSlot"("userId", "groupId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "GroupCustomSlot_userId_groupId_weekStart_day_slot_key" ON "GroupCustomSlot"("userId", "groupId", "weekStart", "day", "slot");

-- CreateIndex
CREATE INDEX "GroupBiweeklySchedule_groupId_parity_idx" ON "GroupBiweeklySchedule"("groupId", "parity");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBiweeklySchedule_groupId_parity_key" ON "GroupBiweeklySchedule"("groupId", "parity");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBiweeklySlot_scheduleId_day_slot_key" ON "GroupBiweeklySlot"("scheduleId", "day", "slot");

-- CreateIndex
CREATE INDEX "BiweeklySlot_userId_parity_idx" ON "BiweeklySlot"("userId", "parity");

-- CreateIndex
CREATE INDEX "BiweeklySlot_groupId_idx" ON "BiweeklySlot"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "BiweeklySlot_userId_parity_day_slot_key" ON "BiweeklySlot"("userId", "parity", "day", "slot");

-- CreateIndex
CREATE INDEX "user_sessions_expire_idx" ON "user_sessions"("expire");
