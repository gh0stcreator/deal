-- CreateEnum
CREATE TYPE "TransportChannel" AS ENUM ('TELEGRAM', 'HTTP');

-- CreateEnum
CREATE TYPE "ProtocolEventOutcome" AS ENUM ('ACCEPTED', 'NO_OP', 'ERROR');

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
  "key" TEXT NOT NULL,
  "channel" "TransportChannel" NOT NULL,
  "caseId" TEXT,
  "participantId" TEXT,
  "actionType" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_channel_caseId_participantId_actionType_payloadHash_createdAt_idx"
ON "IdempotencyRecord"("channel", "caseId", "participantId", "actionType", "payloadHash", "createdAt");

-- CreateTable
CREATE TABLE "ProtocolEvent" (
  "id" TEXT NOT NULL,
  "caseId" TEXT,
  "participantId" TEXT,
  "actionType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "channel" "TransportChannel" NOT NULL,
  "outcome" "ProtocolEventOutcome" NOT NULL,
  "errorCode" TEXT,
  "sessionState" "SessionState",
  "proposalSetVersion" INTEGER,
  "roundNumber" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProtocolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProtocolEvent_caseId_idx" ON "ProtocolEvent"("caseId");

-- CreateIndex
CREATE INDEX "ProtocolEvent_idempotencyKey_idx" ON "ProtocolEvent"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "ProtocolEvent" ADD CONSTRAINT "ProtocolEvent_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
