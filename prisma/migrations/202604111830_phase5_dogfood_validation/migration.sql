CREATE TABLE "SessionEvaluation" (
  "caseId" TEXT NOT NULL,
  "synthesisConfirmed" BOOLEAN NOT NULL,
  "synthesisClarified" BOOLEAN NOT NULL,
  "optionAcceptRate" DOUBLE PRECISION NOT NULL,
  "agreementReached" BOOLEAN NOT NULL,
  "agreementAfterEdit" BOOLEAN NOT NULL,
  "deadlock" BOOLEAN NOT NULL,
  "qualityFlagsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SessionEvaluation_pkey" PRIMARY KEY ("caseId")
);

ALTER TABLE "SessionEvaluation" ADD CONSTRAINT "SessionEvaluation_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
