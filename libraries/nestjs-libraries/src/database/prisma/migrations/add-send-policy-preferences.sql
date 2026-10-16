-- Prepared only. Apply through the deployment migration pipeline after validating aisee_postiz_dev.
-- Global policy values stay in Settings; mutations preserve a durable revision barrier.
CREATE TABLE "UserSendPreference" (
    "userId" TEXT NOT NULL,
    "requirePreselectedAccount" BOOLEAN,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserSendPreference_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "SystemSendPolicyMutationReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SystemSendPolicyMutationReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SystemSendPolicyMutationReceipt_userId_requestId_key"
ON "SystemSendPolicyMutationReceipt"("userId", "requestId");
ALTER TABLE "UserSendPreference" ADD CONSTRAINT "UserSendPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SystemSendPolicyMutationReceipt" ADD CONSTRAINT "SystemSendPolicyMutationReceipt_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
