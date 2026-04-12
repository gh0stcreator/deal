-- CreateTable
CREATE TABLE "ParticipantConversationState" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "currentStage" TEXT NOT NULL,
    "currentQuestionKey" TEXT,
    "expectedInputType" TEXT NOT NULL,
    "currentDraft" TEXT,
    "committedFieldsJson" JSONB NOT NULL,
    "pendingAction" TEXT,
    "lastEventId" INTEGER,
    "lastErrorCode" TEXT,
    "lastInboundEvent" TEXT,
    "lastOutboundAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParticipantConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantConversationState_sessionId_telegramUserId_key"
ON "ParticipantConversationState"("sessionId", "telegramUserId");

-- CreateIndex
CREATE INDEX "ParticipantConversationState_telegramUserId_idx"
ON "ParticipantConversationState"("telegramUserId");

-- CreateIndex
CREATE INDEX "ParticipantConversationState_sessionId_idx"
ON "ParticipantConversationState"("sessionId");

-- AddForeignKey
ALTER TABLE "ParticipantConversationState"
ADD CONSTRAINT "ParticipantConversationState_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "MediationSession"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
