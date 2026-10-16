-- Prepared only. Apply through the deployment migration pipeline after validating the database name.
-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "contentRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "executionProtocol" TEXT,
ADD COLUMN     "routeRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sendBlockCode" TEXT,
ADD COLUMN     "sendOrigin" TEXT,
ADD COLUMN     "sendTarget" JSONB;

-- AlterTable
ALTER TABLE "OperationPlan" ADD COLUMN     "executionRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "executionRoutes" JSONB;

