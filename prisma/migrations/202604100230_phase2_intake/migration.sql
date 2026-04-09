-- CreateEnum
CREATE TYPE "ParticipantIntakeState" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUMMARY_PENDING_CONFIRMATION', 'COMPLETED');

-- CreateEnum
CREATE TYPE "IntakeField" AS ENUM ('FACTS', 'INTERPRETATIONS', 'INTERESTS', 'CONSTRAINTS', 'BOUNDARIES', 'DESIRED_OUTCOME', 'ACCEPTABLE_CONCESSIONS', 'NON_NEGOTIABLES');

-- CreateTable
CREATE TABLE "ParticipantIntake" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "state" "ParticipantIntakeState" NOT NULL,
    "currentField" "IntakeField",
    "normalizedPositionJson" JSONB,
    "generatedSummary" TEXT,
    "summaryVersion" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParticipantIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeRawMessage" (
    "id" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "field" "IntakeField" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeRawMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeAssistantQuestion" (
    "id" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "field" "IntakeField" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeAssistantQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeFieldAnswer" (
    "id" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "field" "IntakeField" NOT NULL,
    "rawValue" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeFieldAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeConfirmedSummary" (
    "id" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "summaryText" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeConfirmedSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantIntake_participantId_key" ON "ParticipantIntake"("participantId");

-- CreateIndex
CREATE INDEX "ParticipantIntake_sessionId_idx" ON "ParticipantIntake"("sessionId");

-- CreateIndex
CREATE INDEX "IntakeRawMessage_intakeId_participantId_idx" ON "IntakeRawMessage"("intakeId", "participantId");

-- CreateIndex
CREATE INDEX "IntakeAssistantQuestion_intakeId_participantId_idx" ON "IntakeAssistantQuestion"("intakeId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeFieldAnswer_intakeId_field_key" ON "IntakeFieldAnswer"("intakeId", "field");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeConfirmedSummary_intakeId_key" ON "IntakeConfirmedSummary"("intakeId");

-- AddForeignKey
ALTER TABLE "ParticipantIntake" ADD CONSTRAINT "ParticipantIntake_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "SessionParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeRawMessage" ADD CONSTRAINT "IntakeRawMessage_intakeId_fkey" FOREIGN KEY ("intakeId") REFERENCES "ParticipantIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAssistantQuestion" ADD CONSTRAINT "IntakeAssistantQuestion_intakeId_fkey" FOREIGN KEY ("intakeId") REFERENCES "ParticipantIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeFieldAnswer" ADD CONSTRAINT "IntakeFieldAnswer_intakeId_fkey" FOREIGN KEY ("intakeId") REFERENCES "ParticipantIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeConfirmedSummary" ADD CONSTRAINT "IntakeConfirmedSummary_intakeId_fkey" FOREIGN KEY ("intakeId") REFERENCES "ParticipantIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
