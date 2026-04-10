import { describe, expect, it } from 'vitest';
import { Clock } from '../../src/application/ports/Clock.js';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { IdGenerator } from '../../src/application/ports/IdGenerator.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import { NegotiationService } from '../../src/application/services/NegotiationService.js';
import { DeterministicProposalMapper } from '../../src/application/services/DeterministicProposalMapper.js';
import { ProposalGenerationService } from '../../src/application/services/ProposalGenerationService.js';
import { DeterministicSynthesisMapper } from '../../src/application/services/DeterministicSynthesisMapper.js';
import { SynthesisService } from '../../src/application/services/SynthesisService.js';
import {
  NegotiationConflictError,
  NegotiationValidationError
} from '../../src/domain/negotiation/errors.js';
import {
  NegotiationActionTypes,
  NegotiationRoundOutcomes,
  SuggestEditOperations
} from '../../src/domain/negotiation/types.js';
import { ProposalVariantTypes } from '../../src/domain/proposal/types.js';
import { SessionStates } from '../../src/domain/session/types.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryMediationSummaryRepository } from '../../src/infrastructure/repositories/InMemoryMediationSummaryRepository.js';
import { InMemoryNegotiationRoundRepository } from '../../src/infrastructure/repositories/InMemoryNegotiationRoundRepository.js';
import { InMemoryProposalSetRepository } from '../../src/infrastructure/repositories/InMemoryProposalSetRepository.js';
import { InMemorySessionRepository } from '../../src/infrastructure/repositories/InMemorySessionRepository.js';

class MutableClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return this.value;
  }

  advanceMs(delta: number): void {
    this.value = new Date(this.value.getTime() + delta);
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

const bootstrap = async () => {
  const clock = new MutableClock(new Date('2026-01-08T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();
  const proposalSetRepo = new InMemoryProposalSetRepository();
  const negotiationRoundRepo = new InMemoryNegotiationRoundRepository();

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
    new DeterministicProposalMapper(),
    ids,
    clock
  );
  const negotiationService = new NegotiationService(
    sessionRepo,
    proposalSetRepo,
    negotiationRoundRepo,
    ids,
    clock
  );

  const created = await mediation.createSession('party-a');
  const joined = await mediation.joinSessionByInviteToken(created.inviteToken, 'party-b');
  await mediation.grantConsent(joined.id, 'party-a');
  await mediation.grantConsent(joined.id, 'party-b');

  await completeIntake(intakeService, joined.id, 'party-a');
  await completeIntake(intakeService, joined.id, 'party-b');
  await synthesisService.synthesizeCase(joined.id);
  await proposalService.generateLatest(joined.id);

  return {
    clock,
    sessionId: joined.id,
    sessionRepo,
    intakeRepo,
    proposalSetRepo,
    negotiationRoundRepo,
    negotiationService
  };
};

describe('negotiation service', () => {
  it('reaches agreement when both participants accept the same variant', async () => {
    const setup = await bootstrap();

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-a',
      actions: [{ type: NegotiationActionTypes.ACCEPT, variant_type: ProposalVariantTypes.BALANCED }]
    });

    const result = await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-b',
      actions: [{ type: NegotiationActionTypes.ACCEPT, variant_type: ProposalVariantTypes.BALANCED }]
    });

    expect(result.outcome).toBe(NegotiationRoundOutcomes.AGREEMENT_REACHED);
    expect(result.session_state).toBe(SessionStates.AGREEMENT_REACHED);
  });

  it('creates new proposal version for conflicting edits', async () => {
    const setup = await bootstrap();
    const base = await setup.proposalSetRepo.findLatestByCaseId(setup.sessionId);
    if (!base) throw new Error('Missing proposal set');

    const clauseId = base.variants[0].clauses[0].clause_id;
    const original = base.variants[0].clauses[0].clause_text;

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-a',
      actions: [
        {
          type: NegotiationActionTypes.SUGGEST_EDIT,
          variant_type: ProposalVariantTypes.BALANCED,
          clause_id: clauseId,
          operation: SuggestEditOperations.MODIFY_CLAUSE_TEXT,
          proposed_value: 'A edit value'
        }
      ]
    });

    const result = await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-b',
      actions: [
        {
          type: NegotiationActionTypes.SUGGEST_EDIT,
          variant_type: ProposalVariantTypes.BALANCED,
          clause_id: clauseId,
          operation: SuggestEditOperations.MODIFY_CLAUSE_TEXT,
          proposed_value: 'B conflicting edit value'
        }
      ]
    });

    expect(result.outcome).toBe(NegotiationRoundOutcomes.CONFLICTING_EDITS);
    expect(result.proposal_set_version).toBe(2);

    const versions = await setup.proposalSetRepo.listByCaseId(setup.sessionId);
    expect(versions).toHaveLength(2);
    expect(versions[1].parent_proposal_set_version).toBe(1);

    const latest = versions[1];
    expect(latest.variants[0].clauses[0].clause_text).toBe(original);
  });

  it('enters deadlock when both participants reject all variants', async () => {
    const setup = await bootstrap();

    const rejects = [
      { type: NegotiationActionTypes.REJECT as const, variant_type: ProposalVariantTypes.BALANCED },
      { type: NegotiationActionTypes.REJECT as const, variant_type: ProposalVariantTypes.A_LEANING },
      { type: NegotiationActionTypes.REJECT as const, variant_type: ProposalVariantTypes.B_LEANING }
    ];

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-a',
      actions: rejects
    });

    const result = await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-b',
      actions: rejects
    });

    expect(result.outcome).toBe(NegotiationRoundOutcomes.DEADLOCK);
    expect(result.session_state).toBe(SessionStates.DEADLOCK);
  });

  it('marks session as abandoned by inactivity timeout', async () => {
    const setup = await bootstrap();

    setup.clock.advanceMs(1000 * 60 * 60 * 25);
    await setup.negotiationService.markAbandonedByInactivity(setup.sessionId, 1000 * 60 * 60 * 24);

    const session = await setup.sessionRepo.findById(setup.sessionId);
    expect(session?.state).toBe(SessionStates.ABANDONED);
  });

  it('maintains version history integrity across rounds', async () => {
    const setup = await bootstrap();

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-a',
      actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: ProposalVariantTypes.BALANCED }]
    });
    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-b',
      actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: ProposalVariantTypes.A_LEANING }]
    });

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-a',
      actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: ProposalVariantTypes.BALANCED }]
    });
    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-b',
      actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: ProposalVariantTypes.B_LEANING }]
    });

    const versions = await setup.proposalSetRepo.listByCaseId(setup.sessionId);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.map((v) => v.parent_proposal_set_version)).toEqual([null, 1, 2]);
    expect(versions.map((v) => v.derived_from_round_number)).toEqual([null, 1, 2]);
  });

  it('applies clause-level edits deterministically', async () => {
    const setup = await bootstrap();
    const base = await setup.proposalSetRepo.findLatestByCaseId(setup.sessionId);
    if (!base) throw new Error('Missing proposal set');

    const clauseId = base.variants[0].clauses[0].clause_id;

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-a',
      actions: [
        {
          type: NegotiationActionTypes.SUGGEST_EDIT,
          variant_type: ProposalVariantTypes.BALANCED,
          clause_id: clauseId,
          operation: SuggestEditOperations.MODIFY_CLAUSE_TEXT,
          proposed_value: 'Updated deterministic clause text'
        }
      ]
    });

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-b',
      actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: ProposalVariantTypes.BALANCED }]
    });

    const latest = await setup.proposalSetRepo.findLatestByCaseId(setup.sessionId);
    if (!latest) throw new Error('Missing latest proposal set');

    expect(latest.version).toBe(2);
    expect(latest.variants[0].clauses[0].clause_text).toBe('Updated deterministic clause text');
  });

  it('preserves participant privacy and symmetry in negotiation views', async () => {
    const setup = await bootstrap();

    const viewA = await setup.negotiationService.getView(setup.sessionId, 'party-a');
    const viewB = await setup.negotiationService.getView(setup.sessionId, 'party-b');

    expect(viewA.proposal_set).toEqual(viewB.proposal_set);
    expect(viewA.current_round_number).toBe(viewB.current_round_number);
    expect(JSON.stringify(viewA)).not.toContain('timeline and payment facts');
    expect(JSON.stringify(viewA)).not.toContain('participant_actions');
  });

  it('rejects duplicate participant submission in the same round', async () => {
    const setup = await bootstrap();

    await setup.negotiationService.submitActions({
      session_id: setup.sessionId,
      telegram_user_id: 'party-a',
      actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: ProposalVariantTypes.BALANCED }]
    });

    await expect(
      setup.negotiationService.submitActions({
        session_id: setup.sessionId,
        telegram_user_id: 'party-a',
        actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: ProposalVariantTypes.A_LEANING }]
      })
    ).rejects.toThrow(NegotiationConflictError);
  });

  it('reaches deadlock after repeated conflicting edit rounds', async () => {
    const setup = await bootstrap();

    for (let i = 1; i <= 3; i += 1) {
      const current = await setup.proposalSetRepo.findLatestByCaseId(setup.sessionId);
      if (!current) throw new Error('Missing proposal set');
      const clauseId = current.variants[0].clauses[0].clause_id;

      await setup.negotiationService.submitActions({
        session_id: setup.sessionId,
        telegram_user_id: 'party-a',
        actions: [
          {
            type: NegotiationActionTypes.SUGGEST_EDIT,
            variant_type: ProposalVariantTypes.BALANCED,
            clause_id: clauseId,
            operation: SuggestEditOperations.MODIFY_CLAUSE_TEXT,
            proposed_value: `A-${i}`
          }
        ]
      });

      const result = await setup.negotiationService.submitActions({
        session_id: setup.sessionId,
        telegram_user_id: 'party-b',
        actions: [
          {
            type: NegotiationActionTypes.SUGGEST_EDIT,
            variant_type: ProposalVariantTypes.BALANCED,
            clause_id: clauseId,
            operation: SuggestEditOperations.MODIFY_CLAUSE_TEXT,
            proposed_value: `B-${i}`
          }
        ]
      });

      if (i < 3) {
        expect(result.outcome).toBe(NegotiationRoundOutcomes.CONFLICTING_EDITS);
      } else {
        expect(result.outcome).toBe(NegotiationRoundOutcomes.DEADLOCK);
        expect(result.session_state).toBe(SessionStates.DEADLOCK);
      }
    }
  });

  it('rejects incomplete clause-level edits', async () => {
    const setup = await bootstrap();
    const current = await setup.proposalSetRepo.findLatestByCaseId(setup.sessionId);
    if (!current) throw new Error('Missing proposal set');

    const clauseId = current.variants[0].clauses[0].clause_id;

    await expect(
      setup.negotiationService.submitActions({
        session_id: setup.sessionId,
        telegram_user_id: 'party-a',
        actions: [
          {
            type: NegotiationActionTypes.SUGGEST_EDIT,
            variant_type: ProposalVariantTypes.BALANCED,
            clause_id: clauseId,
            operation: SuggestEditOperations.MODIFY_CLAUSE_TEXT,
            proposed_value: ''
          }
        ]
      })
    ).rejects.toThrow(NegotiationValidationError);
  });
});
