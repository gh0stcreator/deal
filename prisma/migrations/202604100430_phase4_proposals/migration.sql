-- AlterEnum
ALTER TYPE "SessionState" ADD VALUE IF NOT EXISTS 'SYNTHESIS_COMPLETED';
ALTER TYPE "SessionState" ADD VALUE IF NOT EXISTS 'READY_FOR_PROPOSAL';
ALTER TYPE "SessionState" ADD VALUE IF NOT EXISTS 'PROPOSALS_GENERATED';

-- CreateEnum
CREATE TYPE "ProposalVariantType" AS ENUM ('BALANCED', 'A_LEANING', 'B_LEANING');

-- CreateTable
CREATE TABLE "ProposalSet" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mediationSummaryVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalVariant" (
    "id" TEXT NOT NULL,
    "proposalSetId" TEXT NOT NULL,
    "variantType" "ProposalVariantType" NOT NULL,
    "payloadJson" JSONB NOT NULL,

    CONSTRAINT "ProposalVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProposalSet_caseId_version_key" ON "ProposalSet"("caseId", "version");

-- CreateIndex
CREATE INDEX "ProposalSet_caseId_idx" ON "ProposalSet"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalVariant_proposalSetId_variantType_key" ON "ProposalVariant"("proposalSetId", "variantType");

-- AddForeignKey
ALTER TABLE "ProposalSet" ADD CONSTRAINT "ProposalSet_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "MediationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVariant" ADD CONSTRAINT "ProposalVariant_proposalSetId_fkey" FOREIGN KEY ("proposalSetId") REFERENCES "ProposalSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
