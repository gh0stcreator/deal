import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { NegotiationRoundRepository } from '../ports/NegotiationRoundRepository.js';
import { ProposalSetRepository } from '../ports/ProposalSetRepository.js';
import { SessionRepository } from '../ports/SessionRepository.js';
import {
  markAbandoned,
  markAgreementReached,
  markDeadlock,
  markNegotiationInProgress,
  markPartialAgreement
} from '../../domain/session/stateMachine.js';
import { Participant, SessionState, SessionStates } from '../../domain/session/types.js';
import { SessionNotFoundError } from '../../domain/session/errors.js';
import {
  NegotiationConflictError,
  NegotiationPreconditionError,
  NegotiationValidationError
} from '../../domain/negotiation/errors.js';
import {
  NegotiationAction,
  NegotiationActionTypes,
  NegotiationRound,
  NegotiationRoundOutcomes,
  NegotiationRoundStatuses,
  ParticipantActionBundle,
  SuggestEditAction,
  SuggestEditOperations
} from '../../domain/negotiation/types.js';
import {
  ProposalSet,
  ProposalVariant,
  ProposalVariantType,
  ProposalVariantTypes
} from '../../domain/proposal/types.js';

const REQUIRED_VARIANTS: ProposalVariantType[] = [
  ProposalVariantTypes.BALANCED,
  ProposalVariantTypes.A_LEANING,
  ProposalVariantTypes.B_LEANING
];

const CONFLICTING_EDIT_DEADLOCK_THRESHOLD = 3;

export interface SubmitNegotiationActionsInput {
  session_id: string;
  telegram_user_id: string;
  actions: NegotiationAction[];
}

export interface SubmitNegotiationActionsResult {
  round: NegotiationRound;
  session_state: SessionState;
  proposal_set_version: number;
  outcome: string;
}

export interface NegotiationView {
  session_id: string;
  session_state: SessionState;
  current_round_number: number | null;
  proposal_set: ProposalSet;
  round_status: string | null;
}

export class NegotiationService {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly proposalSetRepository: ProposalSetRepository,
    private readonly negotiationRoundRepository: NegotiationRoundRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock
  ) {}

  async submitActions(input: SubmitNegotiationActionsInput): Promise<SubmitNegotiationActionsResult> {
    if (input.actions.length === 0) {
      throw new NegotiationValidationError('At least one negotiation action is required.');
    }

    let session = await this.sessionRepository.findById(input.session_id);
    if (!session) {
      throw new SessionNotFoundError();
    }

    if (
      session.state !== SessionStates.PROPOSALS_GENERATED &&
      session.state !== SessionStates.NEGOTIATION_IN_PROGRESS
    ) {
      throw new NegotiationPreconditionError(
        `Session must be in PROPOSALS_GENERATED or NEGOTIATION_IN_PROGRESS, got ${session.state}.`
      );
    }

    const participant = this.getParticipant(session.participants, input.telegram_user_id);
    const latestProposalSet = await this.proposalSetRepository.findLatestByCaseId(input.session_id);

    if (!latestProposalSet) {
      throw new NegotiationPreconditionError('Proposal set is required before negotiation actions.');
    }

    this.assertStrictActionSet(input.actions, latestProposalSet);

    if (session.state === SessionStates.PROPOSALS_GENERATED) {
      session = markNegotiationInProgress(session, this.clock.now());
      await this.sessionRepository.save(session);
    }

    let round = await this.negotiationRoundRepository.findOpenByCaseId(input.session_id);

    if (!round) {
      const latestRound = await this.negotiationRoundRepository.findLatestByCaseId(input.session_id);
      round = {
        id: this.idGenerator.nextId(),
        case_id: input.session_id,
        round_number: latestRound ? latestRound.round_number + 1 : 1,
        proposal_set_version: latestProposalSet.version,
        participant_actions: [],
        status: NegotiationRoundStatuses.OPEN,
        outcome: NegotiationRoundOutcomes.PENDING,
        next_proposal_set_version: null,
        created_at: this.clock.now(),
        finalized_at: null
      };
    }

    if (round.proposal_set_version !== latestProposalSet.version) {
      throw new NegotiationConflictError(
        'Open round proposal version is stale. Finalize current round before submitting new actions.'
      );
    }

    if (round.participant_actions.some((bundle) => bundle.participant_id === participant.id)) {
      throw new NegotiationConflictError('Participant already submitted actions for the current round.');
    }

    round.participant_actions.push({
      participant_id: participant.id,
      submitted_at: this.clock.now(),
      actions: input.actions
    });

    if (round.participant_actions.length < 2) {
      await this.negotiationRoundRepository.save(round);
      return {
        round,
        session_state: session.state,
        proposal_set_version: latestProposalSet.version,
        outcome: round.outcome
      };
    }

    const finalized = await this.finalizeRound({
      session,
      proposalSet: latestProposalSet,
      round
    });

    return {
      round: finalized.round,
      session_state: finalized.session.state,
      proposal_set_version: finalized.proposalSetVersion,
      outcome: finalized.round.outcome
    };
  }

  async getView(sessionId: string, telegramUserId: string): Promise<NegotiationView> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    this.getParticipant(session.participants, telegramUserId);

    const proposalSet = await this.proposalSetRepository.findLatestByCaseId(sessionId);
    if (!proposalSet) {
      throw new NegotiationPreconditionError('Proposal set is missing for negotiation view.');
    }

    const round = await this.negotiationRoundRepository.findOpenByCaseId(sessionId);

    return {
      session_id: sessionId,
      session_state: session.state,
      current_round_number: round?.round_number ?? null,
      proposal_set: proposalSet,
      round_status: round?.status ?? null
    };
  }

  async markAbandonedByInactivity(sessionId: string, inactivityMs: number): Promise<void> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    if (
      session.state !== SessionStates.PROPOSALS_GENERATED &&
      session.state !== SessionStates.NEGOTIATION_IN_PROGRESS
    ) {
      throw new NegotiationPreconditionError(
        `Cannot evaluate inactivity for session in state ${session.state}.`
      );
    }

    const latestRound = await this.negotiationRoundRepository.findLatestByCaseId(sessionId);
    const lastActivityAt = latestRound?.finalized_at ?? latestRound?.created_at ?? session.updatedAt;

    if (this.clock.now().getTime() - lastActivityAt.getTime() < inactivityMs) {
      return;
    }

    const abandoned = markAbandoned(session, this.clock.now());
    await this.sessionRepository.save(abandoned);

    if (latestRound && latestRound.status === NegotiationRoundStatuses.OPEN) {
      latestRound.status = NegotiationRoundStatuses.FINALIZED;
      latestRound.outcome = NegotiationRoundOutcomes.ABANDONED;
      latestRound.finalized_at = this.clock.now();
      await this.negotiationRoundRepository.save(latestRound);
    }
  }

  private async finalizeRound(input: {
    session: NonNullable<Awaited<ReturnType<SessionRepository['findById']>>>;
    proposalSet: ProposalSet;
    round: NegotiationRound;
  }): Promise<{
    round: NegotiationRound;
    session: NonNullable<Awaited<ReturnType<SessionRepository['findById']>>>;
    proposalSetVersion: number;
  }> {
    const { session, proposalSet } = input;
    const round = input.round;

    const [partyA, partyB] = this.sortBundlesByRole(session.participants, round.participant_actions);
    const acceptA = this.acceptedVariant(partyA.actions);
    const acceptB = this.acceptedVariant(partyB.actions);

    if (acceptA && acceptB && acceptA === acceptB) {
      round.status = NegotiationRoundStatuses.FINALIZED;
      round.outcome = NegotiationRoundOutcomes.AGREEMENT_REACHED;
      round.finalized_at = this.clock.now();
      await this.negotiationRoundRepository.save(round);

      const agreed = markAgreementReached(session, this.clock.now());
      await this.sessionRepository.save(agreed);

      return { round, session: agreed, proposalSetVersion: proposalSet.version };
    }

    if (this.rejectedAllVariants(partyA.actions) && this.rejectedAllVariants(partyB.actions)) {
      round.status = NegotiationRoundStatuses.FINALIZED;
      round.outcome = NegotiationRoundOutcomes.DEADLOCK;
      round.finalized_at = this.clock.now();
      await this.negotiationRoundRepository.save(round);

      const deadlock = markDeadlock(session, this.clock.now());
      await this.sessionRepository.save(deadlock);

      return { round, session: deadlock, proposalSetVersion: proposalSet.version };
    }

    const editResult = this.applyEdits(proposalSet, session.participants, round.round_number, [
      partyA,
      partyB
    ]);

    const nextProposalSet: ProposalSet = {
      ...proposalSet,
      id: this.idGenerator.nextId(),
      version: proposalSet.version + 1,
      parent_proposal_set_version: proposalSet.version,
      derived_from_round_number: round.round_number,
      created_at: this.clock.now(),
      variants: editResult.variants
    };

    await this.proposalSetRepository.save(nextProposalSet);

    round.status = NegotiationRoundStatuses.FINALIZED;
    round.next_proposal_set_version = nextProposalSet.version;
    round.finalized_at = this.clock.now();

    const samePreferred = this.selectedPreferredVariant(partyA.actions);
    const samePreferredB = this.selectedPreferredVariant(partyB.actions);

    if (
      samePreferred &&
      samePreferredB &&
      samePreferred === samePreferredB &&
      editResult.partialAgreement
    ) {
      round.outcome = NegotiationRoundOutcomes.PARTIAL_AGREEMENT;
      await this.negotiationRoundRepository.save(round);

      const partial = markPartialAgreement(session, this.clock.now());
      await this.sessionRepository.save(partial);

      return { round, session: partial, proposalSetVersion: nextProposalSet.version };
    }

    if (editResult.hasConflicts) {
      round.outcome = NegotiationRoundOutcomes.CONFLICTING_EDITS;
      const rounds = await this.negotiationRoundRepository.listByCaseId(session.id);
      const consecutive = this.countConsecutiveConflictRounds(rounds, round);
      if (consecutive >= CONFLICTING_EDIT_DEADLOCK_THRESHOLD) {
        round.outcome = NegotiationRoundOutcomes.DEADLOCK;
        await this.negotiationRoundRepository.save(round);

        const deadlock = markDeadlock(session, this.clock.now());
        await this.sessionRepository.save(deadlock);

        return { round, session: deadlock, proposalSetVersion: nextProposalSet.version };
      }

      await this.negotiationRoundRepository.save(round);

      return {
        round,
        session,
        proposalSetVersion: nextProposalSet.version
      };
    }

    round.outcome = NegotiationRoundOutcomes.CONTINUE_WITH_NEW_VERSION;
    await this.negotiationRoundRepository.save(round);

    return {
      round,
      session,
      proposalSetVersion: nextProposalSet.version
    };
  }

  private sortBundlesByRole(
    participants: Participant[],
    bundles: ParticipantActionBundle[]
  ): [ParticipantActionBundle, ParticipantActionBundle] {
    const partyA = participants.find((participant) => participant.role === 'PARTY_A');
    const partyB = participants.find((participant) => participant.role === 'PARTY_B');

    if (!partyA || !partyB) {
      throw new NegotiationPreconditionError('Negotiation requires both session participants.');
    }

    const bundleA = bundles.find((bundle) => bundle.participant_id === partyA.id);
    const bundleB = bundles.find((bundle) => bundle.participant_id === partyB.id);

    if (!bundleA || !bundleB) {
      throw new NegotiationConflictError('Round can only finalize when both participants submitted actions.');
    }

    return [bundleA, bundleB];
  }

  private getParticipant(participants: Participant[], telegramUserId: string): Participant {
    const participant = participants.find((entry) => entry.telegramUserId === telegramUserId);
    if (!participant) {
      throw new NegotiationPreconditionError('Participant does not belong to this session.');
    }

    return participant;
  }

  private assertStrictActionSet(actions: NegotiationAction[], proposalSet: ProposalSet): void {
    const variantMap = new Map(proposalSet.variants.map((variant) => [variant.variant_type, variant]));

    let acceptCount = 0;
    let preferredCount = 0;

    const rejectSet = new Set<ProposalVariantType>();
    const editKeys = new Set<string>();

    for (const action of actions) {
      if (!Object.values(NegotiationActionTypes).includes(action.type)) {
        throw new NegotiationValidationError(
          `Unsupported negotiation action ${String((action as { type: string }).type)}.`
        );
      }

      if (!variantMap.has(action.variant_type)) {
        throw new NegotiationValidationError(`Unknown proposal variant ${action.variant_type}.`);
      }

      if (action.type === NegotiationActionTypes.ACCEPT) {
        acceptCount += 1;
      }

      if (action.type === NegotiationActionTypes.SELECT_PREFERRED) {
        preferredCount += 1;
      }

      if (action.type === NegotiationActionTypes.REJECT) {
        if (rejectSet.has(action.variant_type)) {
          throw new NegotiationValidationError(`Duplicate reject for variant ${action.variant_type}.`);
        }
        rejectSet.add(action.variant_type);
      }

      if (action.type === NegotiationActionTypes.SUGGEST_EDIT) {
        const variant = variantMap.get(action.variant_type);
        const clause = variant?.clauses.find((entry) => entry.clause_id === action.clause_id);
        if (!clause) {
          throw new NegotiationValidationError(
            `Suggested edit references unknown clause ${action.clause_id}.`
          );
        }

        if (!Object.values(SuggestEditOperations).includes(action.operation)) {
          throw new NegotiationValidationError(`Unsupported edit operation ${action.operation}.`);
        }

        const editKey = `${action.variant_type}:${action.clause_id}:${action.operation}`;
        if (editKeys.has(editKey)) {
          throw new NegotiationValidationError(
            'Duplicate edit for the same clause and operation is not allowed.'
          );
        }
        editKeys.add(editKey);

        if (
          action.operation !== SuggestEditOperations.MARK_CLAUSE_UNACCEPTABLE &&
          (!action.proposed_value || action.proposed_value.trim().length === 0)
        ) {
          throw new NegotiationValidationError('Edit operation requires a non-empty proposed_value.');
        }

        if (
          action.operation === SuggestEditOperations.MARK_CLAUSE_UNACCEPTABLE &&
          action.proposed_value !== null
        ) {
          throw new NegotiationValidationError('MARK_CLAUSE_UNACCEPTABLE must have null proposed_value.');
        }
      }
    }

    if (acceptCount > 1) {
      throw new NegotiationValidationError('Only one ACCEPT action is allowed per submission.');
    }

    if (preferredCount > 1) {
      throw new NegotiationValidationError(
        'Only one SELECT_PREFERRED action is allowed per submission.'
      );
    }
  }

  private acceptedVariant(actions: NegotiationAction[]): ProposalVariantType | null {
    const accepted = actions.filter((action) => action.type === NegotiationActionTypes.ACCEPT);
    if (accepted.length === 0) {
      return null;
    }

    return accepted[0].variant_type;
  }

  private selectedPreferredVariant(actions: NegotiationAction[]): ProposalVariantType | null {
    const preferred = actions.filter(
      (action) => action.type === NegotiationActionTypes.SELECT_PREFERRED
    );
    if (preferred.length === 0) {
      return null;
    }

    return preferred[0].variant_type;
  }

  private rejectedAllVariants(actions: NegotiationAction[]): boolean {
    const rejects = new Set(
      actions
        .filter((action) => action.type === NegotiationActionTypes.REJECT)
        .map((action) => action.variant_type)
    );

    return REQUIRED_VARIANTS.every((variant) => rejects.has(variant));
  }

  private applyEdits(
    proposalSet: ProposalSet,
    participants: Participant[],
    roundNumber: number,
    bundles: ParticipantActionBundle[]
  ): { variants: ProposalVariant[]; hasConflicts: boolean; partialAgreement: boolean } {
    const participantById = new Map(participants.map((participant) => [participant.id, participant]));
    const copied = structuredClone(proposalSet.variants);

    const suggestions = bundles.flatMap((bundle) =>
      bundle.actions
        .filter((action): action is SuggestEditAction => action.type === NegotiationActionTypes.SUGGEST_EDIT)
        .map((action) => ({
          participantId: bundle.participant_id,
          action
        }))
    );

    const conflictMap = new Map<string, string>();
    const conflictingKeys = new Set<string>();

    for (const item of suggestions) {
      const key = `${item.action.variant_type}:${item.action.clause_id}:${item.action.operation}`;
      const proposed = item.action.proposed_value ?? '__NULL__';
      const existing = conflictMap.get(key);
      if (existing && existing !== proposed) {
        conflictingKeys.add(key);
      } else {
        conflictMap.set(key, proposed);
      }
    }

    const unacceptableClauseIds = new Map<ProposalVariantType, Set<string>>();

    for (const item of suggestions) {
      const participant = participantById.get(item.participantId);
      if (!participant) {
        throw new NegotiationValidationError('Unknown participant action bundle found in round.');
      }

      const key = `${item.action.variant_type}:${item.action.clause_id}:${item.action.operation}`;
      const variant = copied.find((entry) => entry.variant_type === item.action.variant_type);
      if (!variant) {
        continue;
      }

      const clause = variant.clauses.find((entry) => entry.clause_id === item.action.clause_id);
      if (!clause) {
        continue;
      }

      if (conflictingKeys.has(key)) {
        variant.risk_notes.push(
          `Round ${roundNumber}: conflicting edits on clause ${item.action.clause_id}; kept prior clause version.`
        );
        continue;
      }

      if (item.action.operation === SuggestEditOperations.MODIFY_CLAUSE_TEXT) {
        clause.clause_text = item.action.proposed_value as string;
      }

      if (item.action.operation === SuggestEditOperations.ADJUST_TRADEOFF_NOTES) {
        clause.tradeoff_notes = item.action.proposed_value as string;
      }

      if (item.action.operation === SuggestEditOperations.MARK_CLAUSE_UNACCEPTABLE) {
        const set = unacceptableClauseIds.get(variant.variant_type) ?? new Set<string>();
        set.add(item.action.clause_id);
        unacceptableClauseIds.set(variant.variant_type, set);

        variant.unresolved_points.push(
          `Clause ${item.action.clause_id} marked unacceptable by ${participant.role}.`
        );
      }
    }

    let partialAgreement = false;

    for (const variant of copied) {
      const rejected = unacceptableClauseIds.get(variant.variant_type);
      if (!rejected || rejected.size === 0) {
        continue;
      }

      const total = variant.clauses.length;
      const remaining = total - rejected.size;
      if (remaining > 0 && remaining < total) {
        partialAgreement = true;
      }
    }

    return {
      variants: copied,
      hasConflicts: conflictingKeys.size > 0,
      partialAgreement
    };
  }

  private countConsecutiveConflictRounds(
    rounds: NegotiationRound[],
    currentRound: NegotiationRound
  ): number {
    const relevant = [
      ...rounds.filter((round) => round.status === NegotiationRoundStatuses.FINALIZED),
      currentRound
    ].sort((a, b) => a.round_number - b.round_number);

    let count = 0;
    for (let idx = relevant.length - 1; idx >= 0; idx -= 1) {
      if (relevant[idx].outcome === NegotiationRoundOutcomes.CONFLICTING_EDITS) {
        count += 1;
      } else {
        break;
      }
    }

    return count;
  }
}
