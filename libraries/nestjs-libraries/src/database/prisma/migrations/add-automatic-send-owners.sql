-- Prepared migration only. Apply through the project's deployment pipeline.
-- Confirm the datasource is aisee_postiz_dev. Never use prisma db push.
-- Apply after add-send-coordination.sql. Existing automation has no guessed owner;
-- an authenticated operator must save its settings before automatic generation.
-- CreateTable
CREATE TABLE "ProjectSendOwner" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSendOwner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSendOwner_organizationId_projectId_action_key" ON "ProjectSendOwner"("organizationId", "projectId", "action");

-- AddForeignKey
ALTER TABLE "ProjectSendOwner" ADD CONSTRAINT "ProjectSendOwner_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSendOwner" ADD CONSTRAINT "ProjectSendOwner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectSendOwner" ADD CONSTRAINT "ProjectSendOwner_action_check"
  CHECK ("action" IN ('POST', 'REPLY'));
