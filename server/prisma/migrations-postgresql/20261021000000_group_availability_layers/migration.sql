-- AlterTable: every group gets its own colour
ALTER TABLE "PlannerGroup" ADD COLUMN "color" VARCHAR(9) NOT NULL DEFAULT '#5667df';

-- Give existing groups distinct colours (oldest group first)
UPDATE "PlannerGroup" g
SET "color" = (ARRAY['#5667df','#e0569b','#9b5de5','#1ea5d8','#d97706','#c026d3','#2563eb','#be123c','#7c4a2d','#64748b'])[((r.rn - 1) % 10) + 1]
FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS rn FROM "PlannerGroup") r
WHERE r."id" = g."id";

-- CreateTable
CREATE TABLE "GroupStandardSlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "GroupStandardSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupCustomSlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL,

    CONSTRAINT "GroupCustomSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupStandardSlot_userId_groupId_idx" ON "GroupStandardSlot"("userId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupStandardSlot_userId_groupId_day_slot_key" ON "GroupStandardSlot"("userId", "groupId", "day", "slot");

-- CreateIndex
CREATE INDEX "GroupCustomSlot_userId_groupId_weekStart_idx" ON "GroupCustomSlot"("userId", "groupId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "GroupCustomSlot_userId_groupId_weekStart_day_slot_key" ON "GroupCustomSlot"("userId", "groupId", "weekStart", "day", "slot");

-- AddForeignKey
ALTER TABLE "GroupStandardSlot" ADD CONSTRAINT "GroupStandardSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupStandardSlot" ADD CONSTRAINT "GroupStandardSlot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupCustomSlot" ADD CONSTRAINT "GroupCustomSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupCustomSlot" ADD CONSTRAINT "GroupCustomSlot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
