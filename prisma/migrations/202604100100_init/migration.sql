-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('CREATED', 'INVITED', 'BOTH_JOINED', 'CONSENT_PENDING', 'CONSENTED', 'SIDE_A_INTAKE', 'SIDE_B_INTAKE', 'READY_FOR_SYNTHESIS', 'PROPOSAL_READY', 'NEGOTIATION', 'AGREEMENT', 'PARTIAL_AGREEMENT', 'DEADLOCK', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('PARTY_A', 'PARTY_B');

-- CreateTable
CREATE TABLE "MediationSession" (
    "id" TEXT NOT NULL,
    "state" "SessionState" NOT NULL,
    "inviteTokenHash" TEXT NOT NULL,
    "inviteTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionParticipant" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "consentGrantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediationSession_inviteTokenHash_key" ON "MediationSession"("inviteTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "SessionParticipant_sessionId_role_key" ON "SessionParticipant"("sessionId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "SessionParticipant_sessionId_telegramUserId_key" ON "SessionParticipant"("sessionId", "telegramUserId");

-- AddForeignKey
ALTER TABLE "SessionParticipant" ADD CONSTRAINT "SessionParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

