-- CreateTable
CREATE TABLE "MediationSummary" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sharedGoalsJson" JSONB NOT NULL,
    "overlappingInterestsJson" JSONB NOT NULL,
    "conflictingPointsJson" JSONB NOT NULL,
    "constraintsMatrixJson" JSONB NOT NULL,
    "nonNegotiablesConflictsJson" JSONB NOT NULL,
    "potentialAgreementZonesJson" JSONB NOT NULL,
    "riskAreasJson" JSONB NOT NULL,
    "neutralRepresentationJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediationSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediationSummary_caseId_version_key" ON "MediationSummary"("caseId", "version");

-- CreateIndex
CREATE INDEX "MediationSummary_caseId_idx" ON "MediationSummary"("caseId");

-- AddForeignKey
ALTER TABLE "MediationSummary" ADD CONSTRAINT "MediationSummary_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
