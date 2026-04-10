-- CreateEnum
CREATE TYPE "SynthesisReactionType" AS ENUM ('CONFIRM', 'CLARIFY');

-- CreateTable
CREATE TABLE "ProblemSynthesisSnapshot" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "focus" TEXT NOT NULL,
  "sharedPoints" TEXT NOT NULL,
  "divergence" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProblemSynthesisSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SynthesisReviewSignal" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "synthesisVersion" INTEGER NOT NULL,
  "reactionType" "SynthesisReactionType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SynthesisReviewSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProblemSynthesisSnapshot_caseId_idx" ON "ProblemSynthesisSnapshot"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemSynthesisSnapshot_caseId_version_key" ON "ProblemSynthesisSnapshot"("caseId", "version");

-- CreateIndex
CREATE INDEX "SynthesisReviewSignal_caseId_synthesisVersion_idx" ON "SynthesisReviewSignal"("caseId", "synthesisVersion");

-- CreateIndex
CREATE UNIQUE INDEX "SynthesisReviewSignal_caseId_participantId_synthesisVersion_key"
ON "SynthesisReviewSignal"("caseId", "participantId", "synthesisVersion");

-- AddForeignKey
ALTER TABLE "ProblemSynthesisSnapshot" ADD CONSTRAINT "ProblemSynthesisSnapshot_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SynthesisReviewSignal" ADD CONSTRAINT "SynthesisReviewSignal_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SynthesisReviewSignal" ADD CONSTRAINT "SynthesisReviewSignal_participantId_fkey"
  FOREIGN KEY ("participantId") REFERENCES "SessionParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SynthesisReviewSignal" ADD CONSTRAINT "SynthesisReviewSignal_caseId_synthesisVersion_fkey"
  FOREIGN KEY ("caseId", "synthesisVersion") REFERENCES "ProblemSynthesisSnapshot"("caseId", "version") ON DELETE CASCADE ON UPDATE CASCADE;
