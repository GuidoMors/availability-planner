CREATE TABLE "GroupBiweeklySchedule" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "parity" INTEGER NOT NULL,

    CONSTRAINT "GroupBiweeklySchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupBiweeklySlot" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "GroupBiweeklySlot_pkey" PRIMARY KEY ("id")
);

INSERT INTO "GroupBiweeklySchedule" ("id", "groupId", "parity")
SELECT DISTINCT md5(slot."groupId" || ':' || slot."parity"), slot."groupId", slot."parity"
FROM "BiweeklySlot" slot
JOIN "PlannerGroup" group_row ON group_row."id" = slot."groupId" AND group_row."ownerId" = slot."userId"
WHERE slot."available" = true;

INSERT INTO "GroupBiweeklySlot" ("id", "scheduleId", "day", "slot")
SELECT md5(slot."groupId" || ':' || slot."parity"), md5(slot."groupId" || ':' || slot."parity"), slot."day", slot."slot"
FROM "BiweeklySlot" slot
JOIN "PlannerGroup" group_row ON group_row."id" = slot."groupId" AND group_row."ownerId" = slot."userId"
WHERE slot."available" = true;

CREATE UNIQUE INDEX "GroupBiweeklySchedule_groupId_parity_key"
ON "GroupBiweeklySchedule"("groupId", "parity");

CREATE INDEX "GroupBiweeklySchedule_groupId_parity_idx"
ON "GroupBiweeklySchedule"("groupId", "parity");

CREATE UNIQUE INDEX "GroupBiweeklySlot_scheduleId_day_slot_key"
ON "GroupBiweeklySlot"("scheduleId", "day", "slot");

ALTER TABLE "GroupBiweeklySchedule"
ADD CONSTRAINT "GroupBiweeklySchedule_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "PlannerGroup"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupBiweeklySlot"
ADD CONSTRAINT "GroupBiweeklySlot_scheduleId_fkey"
FOREIGN KEY ("scheduleId") REFERENCES "GroupBiweeklySchedule"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
