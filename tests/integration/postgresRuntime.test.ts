import { execSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { SystemClock } from '../../src/application/ports/Clock.js';
import { RandomIdGenerator } from '../../src/application/ports/IdGenerator.js';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { DeterministicProposalMapper } from '../../src/application/services/DeterministicProposalMapper.js';
import { DeterministicSynthesisMapper } from '../../src/application/services/DeterministicSynthesisMapper.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import { NegotiationService } from '../../src/application/services/NegotiationService.js';
import { ProposalGenerationService } from '../../src/application/services/ProposalGenerationService.js';
import { ProtocolGatewayService } from '../../src/application/services/ProtocolGatewayService.js';
import { SynthesisService } from '../../src/application/services/SynthesisService.js';
import { buildHttpServer } from '../../src/infrastructure/http/server.js';
import { PrismaIntakeRepository } from '../../src/infrastructure/repositories/PrismaIntakeRepository.js';
import { PrismaMediationSummaryRepository } from '../../src/infrastructure/repositories/PrismaMediationSummaryRepository.js';
import { PrismaNegotiationRoundRepository } from '../../src/infrastructure/repositories/PrismaNegotiationRoundRepository.js';
import { PrismaProposalSetRepository } from '../../src/infrastructure/repositories/PrismaProposalSetRepository.js';
import { PrismaProtocolTrackingRepository } from '../../src/infrastructure/repositories/PrismaProtocolTrackingRepository.js';
import { PrismaSessionRepository } from '../../src/infrastructure/repositories/PrismaSessionRepository.js';
import { InMemoryRateLimiter } from '../../src/infrastructure/transport/rateLimiter.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DB_URL ? describe : describe.skip;

const intakeAnswers = {
  facts: 'payment timeline and scope changes',
  interpretations: 'different expectations on deadlines',
  interests: 'predictability and trust',
  constraints: 'fixed budget and release date',
  boundaries: 'no threats, respectful communication',
  desired_outcome: 'clear schedule and responsibilities',
  acceptable_concessions: 'minor milestone flexibility',
  non_negotiables: 'no legal escalation'
} as const;

describePostgres('postgres runtime integration', () => {
  let prisma: PrismaClient | null = null;
  let gateway: ProtocolGatewayService;
  let intakeService: IntakeService;
  let synthesisService: SynthesisService;
  let proposalService: ProposalGenerationService;
  let app: ReturnType<typeof buildHttpServer> | null = null;

  beforeAll(async () => {
    execSync('corepack pnpm prisma migrate deploy', {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB_URL
      },
      stdio: 'pipe'
    });

    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DB_URL } }
    });

    const clock = new SystemClock();
    const ids = new RandomIdGenerator();
    const sessionRepo = new PrismaSessionRepository(prisma);
    const intakeRepo = new PrismaIntakeRepository(prisma);
    const summaryRepo = new PrismaMediationSummaryRepository(prisma);
    const proposalSetRepo = new PrismaProposalSetRepository(prisma);
    const roundRepo = new PrismaNegotiationRoundRepository(prisma);
    const protocolRepo = new PrismaProtocolTrackingRepository(prisma);

    const mediationService = new MediationService(sessionRepo, clock, ids);
    intakeService = new IntakeService(
      sessionRepo,
      intakeRepo,
      new DeterministicIntakeNormalizer(),
      ids,
      clock
    );
    synthesisService = new SynthesisService(
      sessionRepo,
      intakeRepo,
      summaryRepo,
      new DeterministicSynthesisMapper(),
      ids,
      clock
    );
    proposalService = new ProposalGenerationService(
      sessionRepo,
      summaryRepo,
      proposalSetRepo,
      new DeterministicProposalMapper(),
      ids,
      clock
    );
    const negotiationService = new NegotiationService(
      sessionRepo,
      proposalSetRepo,
      roundRepo,
      ids,
      clock
    );

    gateway = new ProtocolGatewayService(
      mediationService,
      intakeService,
      synthesisService,
      proposalService,
      negotiationService,
      sessionRepo,
      proposalSetRepo,
      protocolRepo,
      ids,
      clock
    );
    app = buildHttpServer(gateway, {
      rate_limiter: new InMemoryRateLimiter(clock),
      clock
    });
  });

  beforeEach(async () => {
    if (!prisma) {
      return;
    }

    await prisma.protocolEvent.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.negotiationRound.deleteMany();
    await prisma.proposalVariant.deleteMany();
    await prisma.proposalSet.deleteMany();
    await prisma.mediationSummary.deleteMany();
    await prisma.intakeConfirmedSummary.deleteMany();
    await prisma.intakeFieldAnswer.deleteMany();
    await prisma.intakeAssistantQuestion.deleteMany();
    await prisma.intakeRawMessage.deleteMany();
    await prisma.participantIntake.deleteMany();
    await prisma.sessionParticipant.deleteMany();
    await prisma.mediationSession.deleteMany();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  const completeIntake = async (sessionId: string, telegramUserId: string) => {
    let view = await intakeService.startOrResume(sessionId, telegramUserId);
    for (const field of Object.keys(intakeAnswers) as Array<keyof typeof intakeAnswers>) {
      view = await intakeService.submitFieldAnswer({
        sessionId,
        telegramUserId,
        field,
        rawValue: intakeAnswers[field],
        expectedVersion: view.version
      });
    }

    await intakeService.confirmSummary({
      sessionId,
      telegramUserId,
      summary: view.generatedSummary!,
      expectedVersion: view.version
    });
  };

  it('boots from migration chain and records migration history', async () => {
    const migrations = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 1'
    );
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('persists protocol flow with idempotency and audit events', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/sessions/create',
      headers: {
        'x-idempotency-key': 'create-1',
        'x-correlation-id': 'corr-create-1'
      },
      payload: { telegramUserId: '101' }
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/sessions/create',
      headers: {
        'x-idempotency-key': 'create-1',
        'x-correlation-id': 'corr-create-1'
      },
      payload: { telegramUserId: '101' }
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().session_id).toBe(created.json().session_id);

    const join = await app.inject({
      method: 'POST',
      url: '/sessions/join',
      payload: {
        telegramUserId: '102',
        inviteToken: created.json().invite_token
      }
    });
    expect(join.statusCode).toBe(200);
    const sessionId = join.json().session_id as string;

    await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/consent`,
      payload: { telegramUserId: '101' }
    });
    await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/consent`,
      payload: { telegramUserId: '102' }
    });

    await completeIntake(sessionId, '101');
    await completeIntake(sessionId, '102');
    await synthesisService.synthesizeCase(sessionId);
    await proposalService.generateLatest(sessionId);

    const select = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/negotiation/select-preferred`,
      headers: {
        'x-idempotency-key': 'select-1',
        'x-correlation-id': 'corr-select-1'
      },
      payload: { telegramUserId: '101', variantType: 'BALANCED' }
    });
    expect(select.statusCode).toBe(200);
    expect(select.headers['x-correlation-id']).toBe('corr-select-1');

    const replay = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/negotiation/select-preferred`,
      headers: {
        'x-idempotency-key': 'select-1',
        'x-correlation-id': 'corr-select-1'
      },
      payload: { telegramUserId: '101', variantType: 'BALANCED' }
    });
    expect(replay.statusCode).toBe(200);

    const idempotency = await prisma.idempotencyRecord.findMany({
      where: { caseId: sessionId, actionType: 'select_preferred' }
    });
    expect(idempotency).toHaveLength(1);
    expect(idempotency[0].key).toContain('corr-select-1');

    const events = await prisma.protocolEvent.findMany({
      where: { caseId: sessionId, actionType: 'select_preferred' },
      orderBy: { createdAt: 'asc' }
    });
    expect(events.some((event) => event.outcome === 'ACCEPTED')).toBe(true);
    expect(events.some((event) => event.outcome === 'NO_OP')).toBe(true);
  });

  it('persists proposal and negotiation version lineage', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/sessions/create',
      payload: { telegramUserId: '101' }
    });
    const join = await app.inject({
      method: 'POST',
      url: '/sessions/join',
      payload: {
        telegramUserId: '102',
        inviteToken: created.json().invite_token
      }
    });
    const sessionId = join.json().session_id as string;

    await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/consent`,
      payload: { telegramUserId: '101' }
    });
    await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/consent`,
      payload: { telegramUserId: '102' }
    });

    await completeIntake(sessionId, '101');
    await completeIntake(sessionId, '102');
    await synthesisService.synthesizeCase(sessionId);
    await proposalService.generateLatest(sessionId);

    const proposals = await gateway.getLatestProposalSet(sessionId, '101');
    const balanced = proposals?.variants.find((variant) => variant.variantType === 'BALANCED');
    const payload = balanced?.payload as { clauses?: Array<{ clause_id: string }> } | undefined;
    const clauseId = payload?.clauses?.[0]?.clause_id ?? 'payment_plan';

    const a = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/negotiation/suggest-edit`,
      payload: {
        telegramUserId: '101',
        variantType: 'BALANCED',
        clauseId,
        operation: 'MODIFY_CLAUSE_TEXT',
        proposedValue: 'updated by A'
      }
    });
    const b = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/negotiation/suggest-edit`,
      payload: {
        telegramUserId: '102',
        variantType: 'BALANCED',
        clauseId,
        operation: 'MODIFY_CLAUSE_TEXT',
        proposedValue: 'updated by B'
      }
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const sets = await prisma.proposalSet.findMany({
      where: { caseId: sessionId },
      orderBy: { version: 'asc' }
    });
    expect(sets.length).toBeGreaterThan(1);
    expect(sets[sets.length - 1].parentProposalSetVersion).toBe(sets[sets.length - 2].version);

    const rounds = await prisma.negotiationRound.findMany({ where: { caseId: sessionId } });
    expect(rounds.length).toBeGreaterThan(0);
  });
});
