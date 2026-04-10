import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/application/ports/Clock.js';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { IdGenerator } from '../../src/application/ports/IdGenerator.js';
import { ProposalMapper } from '../../src/application/ports/ProposalMapper.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import { DeterministicProposalMapper } from '../../src/application/services/DeterministicProposalMapper.js';
import { ProposalGenerationService } from '../../src/application/services/ProposalGenerationService.js';
import { DeterministicSynthesisMapper } from '../../src/application/services/DeterministicSynthesisMapper.js';
import { SynthesisService } from '../../src/application/services/SynthesisService.js';
import {
  ProposalPreconditionError,
  ProposalValidationError
} from '../../src/domain/proposal/errors.js';
import { ProposalVariantTypes } from '../../src/domain/proposal/types.js';
import { SessionStates } from '../../src/domain/session/types.js';
import { MediationSummary } from '../../src/domain/synthesis/types.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryMediationSummaryRepository } from '../../src/infrastructure/repositories/InMemoryMediationSummaryRepository.js';
import { InMemoryProposalSetRepository } from '../../src/infrastructure/repositories/InMemoryProposalSetRepository.js';
import { InMemorySessionRepository } from '../../src/infrastructure/repositories/InMemorySessionRepository.js';

class FixedClock extends SystemClock {
  constructor(private readonly value: Date) {
    super();
  }

  now(): Date {
    return this.value;
  }
}

class SequentialIdGenerator implements IdGenerator {
  private value = 0;

  nextId(): string {
    this.value += 1;
    return `id-${this.value}`;
  }
}

const intakeAnswers = {
  facts: 'timeline and payment facts',
  interpretations: 'different interpretation of missed milestones',
  interests: 'predictability and communication quality',
  constraints: 'time schedule and budget constraints',
  boundaries: 'respectful tone and no threats',
  desired_outcome: 'predictable schedule and clear ownership',
  acceptable_concessions: 'can adjust timeline and milestone size',
  non_negotiables: 'no legal escalation'
} as const;

const completeIntake = async (
  intakeService: IntakeService,
  sessionId: string,
  telegramUserId: string,
  override?: Partial<typeof intakeAnswers>
) => {
  const answers = { ...intakeAnswers, ...override };
  let view = await intakeService.startOrResume(sessionId, telegramUserId);

  for (const field of Object.keys(answers) as Array<keyof typeof answers>) {
    view = await intakeService.submitFieldAnswer({
      sessionId,
      telegramUserId,
      field,
      rawValue: answers[field],
      expectedVersion: view.version
    });
  }

  if (!view.generatedSummary) {
    throw new Error('Expected summary');
  }

  await intakeService.confirmSummary({
    sessionId,
    telegramUserId,
    summary: view.generatedSummary,
    expectedVersion: view.version
  });
};

const bootstrap = async (proposalMapper?: ProposalMapper) => {
  const clock = new FixedClock(new Date('2026-01-05T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();
  const proposalSetRepo = new InMemoryProposalSetRepository();

  const mediation = new MediationService(sessionRepo, clock, ids);
  const intakeService = new IntakeService(
    sessionRepo,
    intakeRepo,
    new DeterministicIntakeNormalizer(),
    ids,
    clock
  );
  const synthesisService = new SynthesisService(
    sessionRepo,
    intakeRepo,
    summaryRepo,
    new DeterministicSynthesisMapper(),
    ids,
    clock
  );

  const proposalService = new ProposalGenerationService(
    sessionRepo,
    summaryRepo,
    proposalSetRepo,
    proposalMapper ?? new DeterministicProposalMapper(),
    ids,
    clock
  );

  const created = await mediation.createSession('party-a');
  const joined = await mediation.joinSessionByInviteToken(created.inviteToken, 'party-b');
  await mediation.grantConsent(joined.id, 'party-a');
  await mediation.grantConsent(joined.id, 'party-b');

  await completeIntake(intakeService, joined.id, 'party-a');
  await completeIntake(intakeService, joined.id, 'party-b');
  const summary = await synthesisService.synthesizeCase(joined.id);

  return {
    sessionId: joined.id,
    summary,
    proposalService,
    summaryRepo,
    sessionRepo,
    intakeRepo,
    proposalSetRepo
  };
};

describe('proposal generation service', () => {
  it('rejects generation from invalid session state', async () => {
    const clock = new FixedClock(new Date('2026-01-05T00:00:00.000Z'));
    const ids = new SequentialIdGenerator();
    const sessionRepo = new InMemorySessionRepository();
    const summaryRepo = new InMemoryMediationSummaryRepository();
    const proposalSetRepo = new InMemoryProposalSetRepository();
    const mediation = new MediationService(sessionRepo, clock, ids);

    const created = await mediation.createSession('party-a');
    const service = new ProposalGenerationService(
      sessionRepo,
      summaryRepo,
      proposalSetRepo,
      new DeterministicProposalMapper(),
      ids,
      clock
    );

    await expect(service.generateLatest(created.session.id)).rejects.toThrow(ProposalPreconditionError);
  });

  it('uses only mediation summary inputs (no raw leakage)', async () => {
    const setup = await bootstrap();

    const raw = await setup.intakeRepo.findRawMessages('id-2', 'id-1:PARTY_A');
    expect(Array.isArray(raw)).toBe(true);

    const proposals = await setup.proposalService.generateLatest(setup.sessionId);
    const serialized = JSON.stringify(proposals);

    expect(serialized).not.toContain('timeline and payment facts');
    expect(serialized).not.toContain('SECRET_RAW_MARKER');
  });

  it('is deterministic for identical summary input shape', async () => {
    const one = await bootstrap();
    const two = await bootstrap();

    const p1 = await one.proposalService.generateLatest(one.sessionId);
    const p2 = await two.proposalService.generateLatest(two.sessionId);

    expect(p1.variants).toEqual(p2.variants);
  });

  it('always generates 3 required variants and they differ meaningfully', async () => {
    const setup = await bootstrap();
    const proposals = await setup.proposalService.generateLatest(setup.sessionId);

    expect(proposals.variants).toHaveLength(3);
    expect(new Set(proposals.variants.map((v) => v.variant_type))).toEqual(
      new Set([
        ProposalVariantTypes.BALANCED,
        ProposalVariantTypes.A_LEANING,
        ProposalVariantTypes.B_LEANING
      ])
    );

    const summaries = proposals.variants.map((v) => v.summary);
    expect(new Set(summaries).size).toBe(3);

    for (const variant of proposals.variants) {
      expect(variant.clauses.length).toBeGreaterThan(0);
      expect(variant.review_window.length).toBeGreaterThan(0);
    }
  });

  it('reflects non-negotiables conflict as weaker risk profile', async () => {
    const setup = await bootstrap();
    const conflictSummary: MediationSummary = {
      ...setup.summary,
      version: setup.summary.version + 1,
      content: {
        ...setup.summary.content,
        non_negotiables_conflicts: ['Formal/legal process'],
        risk_areas: ['Direct conflict in non-negotiable conditions']
      }
    };

    await setup.summaryRepo.save(conflictSummary);

    const proposals = await setup.proposalService.generateLatest(setup.sessionId);
    for (const variant of proposals.variants) {
      expect(variant.risk_notes.some((note) => /conflict|risk/i.test(note))).toBe(true);
    }
  });

  it('handles zero-overlap via minimal fallback structure', async () => {
    const setup = await bootstrap();
    const weakSummary: MediationSummary = {
      ...setup.summary,
      version: setup.summary.version + 1,
      content: {
        ...setup.summary.content,
        shared_goals: [],
        overlapping_interests: [],
        potential_agreement_zones: [],
        risk_areas: ['Low overlap in articulated goals and interests']
      }
    };

    await setup.summaryRepo.save(weakSummary);

    const proposals = await setup.proposalService.generateLatest(setup.sessionId);
    for (const variant of proposals.variants) {
      expect(variant.fallback_if_broken.agreed_now.length).toBeGreaterThan(0);
      expect(variant.fallback_if_broken.continue_path.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid/incomplete synthesis summaries', async () => {
    const setup = await bootstrap();
    const brokenSummary = {
      ...setup.summary,
      version: setup.summary.version + 1,
      content: {
        ...setup.summary.content,
        constraints_matrix: null as unknown as MediationSummary['content']['constraints_matrix']
      }
    };

    await setup.summaryRepo.save(brokenSummary as MediationSummary);

    await expect(setup.proposalService.generateLatest(setup.sessionId)).rejects.toThrow(
      ProposalPreconditionError
    );
  });

  it('rejects contradictory clauses inside a single proposal', async () => {
    const contradictoryMapper: ProposalMapper = {
      async generateVariants() {
        return [
          {
            variant_type: ProposalVariantTypes.BALANCED,
            title: 'x',
            summary: 'x1',
            clauses: [
              {
                clause_id: 'c1',
                topic: 'payment',
                clause_text: 'Payment must be made weekly.',
                rationale: 'x',
                tradeoff_notes: 'x'
              },
              {
                clause_id: 'c2',
                topic: 'payment',
                clause_text: 'Payment must not be made weekly.',
                rationale: 'x',
                tradeoff_notes: 'x'
              }
            ],
            unresolved_points: [],
            risk_notes: ['risk'],
            review_window: '7 days',
            fallback_if_broken: {
              agreed_now: ['x'],
              unresolved: ['x'],
              fixed_boundaries: ['x'],
              continue_path: 'x'
            }
          },
          {
            variant_type: ProposalVariantTypes.A_LEANING,
            title: 'a',
            summary: 'a1',
            clauses: [
              {
                clause_id: 'a1',
                topic: 'scope',
                clause_text: 'Scope is limited to baseline.',
                rationale: 'x',
                tradeoff_notes: 'x'
              }
            ],
            unresolved_points: [],
            risk_notes: ['risk'],
            review_window: '7 days',
            fallback_if_broken: {
              agreed_now: ['x'],
              unresolved: ['x'],
              fixed_boundaries: ['x'],
              continue_path: 'x'
            }
          },
          {
            variant_type: ProposalVariantTypes.B_LEANING,
            title: 'b',
            summary: 'b1',
            clauses: [
              {
                clause_id: 'b1',
                topic: 'scope',
                clause_text: 'Scope is limited to baseline.',
                rationale: 'x',
                tradeoff_notes: 'x'
              }
            ],
            unresolved_points: [],
            risk_notes: ['risk'],
            review_window: '7 days',
            fallback_if_broken: {
              agreed_now: ['x'],
              unresolved: ['x'],
              fixed_boundaries: ['x'],
              continue_path: 'x'
            }
          }
        ];
      }
    };

    const setup = await bootstrap(contradictoryMapper);

    await expect(setup.proposalService.generateLatest(setup.sessionId)).rejects.toThrow(
      ProposalValidationError
    );
  });

  it('persists proposal sets with case-version increments', async () => {
    const setup = await bootstrap();

    const first = await setup.proposalService.generateLatest(setup.sessionId);
    expect(first.version).toBe(1);
    expect(first.mediation_summary_version).toBe(setup.summary.version);

    const session = await setup.sessionRepo.findById(setup.sessionId);
    if (!session) {
      throw new Error('Missing session');
    }

    await setup.sessionRepo.save({
      ...session,
      state: SessionStates.READY_FOR_PROPOSAL,
      updatedAt: new Date('2026-01-05T00:00:00.000Z')
    });

    const second = await setup.proposalService.generateLatest(setup.sessionId);
    expect(second.version).toBe(2);

    const stored = await setup.proposalSetRepo.findLatestByCaseId(setup.sessionId);
    expect(stored?.version).toBe(2);
  });
});
