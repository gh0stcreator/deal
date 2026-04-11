CREATE TYPE "DraftAgreementResponseType" AS ENUM ('CONFIRM', 'REQUEST_CHANGE', 'REJECT');
CREATE TYPE "DraftAgreementOutcomeType" AS ENUM ('AGREEMENT', 'PARTIAL_AGREEMENT', 'DEADLOCK');

CREATE TABLE "DraftAgreement" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "loopVersion" INTEGER NOT NULL,
  "sourceOptionId" TEXT NOT NULL,
  "agreementTitle" TEXT NOT NULL,
  "agreedActionsJson" JSONB NOT NULL,
  "boundariesJson" JSONB NOT NULL,
  "conditionsJson" JSONB NOT NULL,
  "fallbackRule" TEXT NOT NULL,
  "reviewPoint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DraftAgreement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DraftAgreementResponse" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "draftVersion" INTEGER NOT NULL,
  "participantId" TEXT NOT NULL,
  "responseType" "DraftAgreementResponseType" NOT NULL,
  "changeRequest" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DraftAgreementResponse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DraftAgreementOutcome" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "draftVersion" INTEGER NOT NULL,
  "outcome" "DraftAgreementOutcomeType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DraftAgreementOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DraftAgreement_caseId_version_key" ON "DraftAgreement"("caseId", "version");
CREATE INDEX "DraftAgreement_caseId_idx" ON "DraftAgreement"("caseId");

CREATE UNIQUE INDEX "DraftAgreementResponse_caseId_draftVersion_participantId_key"
ON "DraftAgreementResponse"("caseId", "draftVersion", "participantId");
CREATE INDEX "DraftAgreementResponse_caseId_draftVersion_idx"
ON "DraftAgreementResponse"("caseId", "draftVersion");

CREATE UNIQUE INDEX "DraftAgreementOutcome_caseId_draftVersion_key"
ON "DraftAgreementOutcome"("caseId", "draftVersion");
CREATE INDEX "DraftAgreementOutcome_caseId_idx" ON "DraftAgreementOutcome"("caseId");

ALTER TABLE "DraftAgreement" ADD CONSTRAINT "DraftAgreement_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DraftAgreementResponse" ADD CONSTRAINT "DraftAgreementResponse_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DraftAgreementResponse" ADD CONSTRAINT "DraftAgreementResponse_participantId_fkey"
FOREIGN KEY ("participantId") REFERENCES "SessionParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DraftAgreementResponse" ADD CONSTRAINT "DraftAgreementResponse_caseId_draftVersion_fkey"
FOREIGN KEY ("caseId", "draftVersion") REFERENCES "DraftAgreement"("caseId", "version") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DraftAgreementOutcome" ADD CONSTRAINT "DraftAgreementOutcome_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DraftAgreementOutcome" ADD CONSTRAINT "DraftAgreementOutcome_caseId_draftVersion_fkey"
FOREIGN KEY ("caseId", "draftVersion") REFERENCES "DraftAgreement"("caseId", "version") ON DELETE CASCADE ON UPDATE CASCADE;
