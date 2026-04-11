CREATE TYPE "IssueReactionType" AS ENUM ('ACCEPT', 'REJECT', 'REQUEST_CHANGE');

CREATE TABLE "IssueResolutionLoop" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "synthesisVersion" INTEGER NOT NULL,
  "issueTitle" TEXT NOT NULL,
  "sideAPriority" TEXT NOT NULL,
  "sideBPriority" TEXT NOT NULL,
  "issueConstraintsJson" JSONB NOT NULL,
  "optionsJson" JSONB NOT NULL,
  "optionTradeoffsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "IssueResolutionLoop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IssueResolutionReaction" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "loopVersion" INTEGER NOT NULL,
  "participantId" TEXT NOT NULL,
  "optionId" TEXT NOT NULL,
  "reactionType" "IssueReactionType" NOT NULL,
  "changeRequest" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "IssueResolutionReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IssueResolutionLoop_caseId_version_key" ON "IssueResolutionLoop"("caseId", "version");
CREATE INDEX "IssueResolutionLoop_caseId_idx" ON "IssueResolutionLoop"("caseId");

CREATE UNIQUE INDEX "IssueResolutionReaction_caseId_loopVersion_participantId_optionId_key"
ON "IssueResolutionReaction"("caseId", "loopVersion", "participantId", "optionId");
CREATE INDEX "IssueResolutionReaction_caseId_loopVersion_idx"
ON "IssueResolutionReaction"("caseId", "loopVersion");

ALTER TABLE "IssueResolutionLoop" ADD CONSTRAINT "IssueResolutionLoop_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueResolutionReaction" ADD CONSTRAINT "IssueResolutionReaction_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueResolutionReaction" ADD CONSTRAINT "IssueResolutionReaction_participantId_fkey"
FOREIGN KEY ("participantId") REFERENCES "SessionParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueResolutionReaction" ADD CONSTRAINT "IssueResolutionReaction_caseId_loopVersion_fkey"
FOREIGN KEY ("caseId", "loopVersion") REFERENCES "IssueResolutionLoop"("caseId", "version") ON DELETE CASCADE ON UPDATE CASCADE;
