ALTER TABLE "User" ADD COLUMN "biweeklyAnchorWeekStart" DATE;

CREATE TABLE "BiweeklySlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT,
    "parity" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL,

    CONSTRAINT "BiweeklySlot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BiweeklySlot_userId_parity_day_slot_key" ON "BiweeklySlot"("userId", "parity", "day", "slot");
CREATE INDEX "BiweeklySlot_userId_parity_idx" ON "BiweeklySlot"("userId", "parity");
CREATE INDEX "BiweeklySlot_groupId_idx" ON "BiweeklySlot"("groupId");

ALTER TABLE "BiweeklySlot" ADD CONSTRAINT "BiweeklySlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BiweeklySlot" ADD CONSTRAINT "BiweeklySlot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PlannerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;