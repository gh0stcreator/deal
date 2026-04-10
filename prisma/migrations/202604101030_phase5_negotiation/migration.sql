-- AlterEnum
ALTER TYPE "SessionState" ADD VALUE IF NOT EXISTS 'NEGOTIATION_IN_PROGRESS';
ALTER TYPE "SessionState" ADD VALUE IF NOT EXISTS 'AGREEMENT_REACHED';

-- CreateEnum
CREATE TYPE "NegotiationActionType" AS ENUM ('ACCEPT', 'REJECT', 'SUGGEST_EDIT', 'SELECT_PREFERRED');

-- CreateEnum
CREATE TYPE "NegotiationRoundStatus" AS ENUM ('OPEN', 'FINALIZED');

-- CreateEnum
CREATE TYPE "NegotiationRoundOutcome" AS ENUM (
  'PENDING',
  'CONTINUE_WITH_NEW_VERSION',
  'CONFLICTING_EDITS',
  'AGREEMENT_REACHED',
  'PARTIAL_AGREEMENT',
  'DEADLOCK',
  'ABANDONED'
);

-- AlterTable
ALTER TABLE "ProposalSet"
  ADD COLUMN "parentProposalSetVersion" INTEGER,
  ADD COLUMN "derivedFromRoundNumber" INTEGER;

-- CreateTable
CREATE TABLE "NegotiationRound" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "roundNumber" INTEGER NOT NULL,
  "proposalSetVersion" INTEGER NOT NULL,
  "participantActionsJson" JSONB NOT NULL,
  "status" "NegotiationRoundStatus" NOT NULL DEFAULT 'OPEN',
  "outcome" "NegotiationRoundOutcome" NOT NULL DEFAULT 'PENDING',
  "nextProposalSetVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalizedAt" TIMESTAMP(3),

  CONSTRAINT "NegotiationRound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NegotiationRound_caseId_roundNumber_key" ON "NegotiationRound"("caseId", "roundNumber");

-- CreateIndex
CREATE INDEX "NegotiationRound_caseId_idx" ON "NegotiationRound"("caseId");

-- AddForeignKey
ALTER TABLE "NegotiationRound" ADD CONSTRAINT "NegotiationRound_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
