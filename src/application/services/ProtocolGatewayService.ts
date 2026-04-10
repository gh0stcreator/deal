import { createHash } from 'node:crypto';
import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { IntakeService, IntakeView } from './IntakeService.js';
import { MediationService } from './MediationService.js';
import { NegotiationService, SubmitNegotiationActionsResult } from './NegotiationService.js';
import { ProposalGenerationService } from './ProposalGenerationService.js';
import { SynthesisService } from './SynthesisService.js';
import { ProposalSetRepository } from '../ports/ProposalSetRepository.js';
import { SessionRepository } from '../ports/SessionRepository.js';
import { ProtocolTrackingRepository } from '../ports/ProtocolTrackingRepository.js';
import {
  IdempotencyRecord,
  ProtocolEventOutcomes,
  TransportChannel
} from '../../domain/protocol/types.js';
import { ProposalSet, ProposalVariantType } from '../../domain/proposal/types.js';
import { SessionNotFoundError } from '../../domain/session/errors.js';
import { SessionState, SessionStates } from '../../domain/session/types.js';
import { IntakeValidationError } from '../../domain/intake/errors.js';
import { SynthesisPreconditionError } from '../../domain/synthesis/errors.js';
import {
  NegotiationActionTypes,
  SuggestEditOperation
} from '../../domain/negotiation/types.js';
import { TransportAccessDeniedError } from '../../domain/protocol/errors.js';
import { DomainError } from '../../domain/session/errors.js';
import { AppLogger, createNoopLogger } from '../ports/AppLogger.js';

const RETRY_WINDOW_MS = 20_000;

const synthesisThemes: Array<{ label: string; keywords: RegExp[] }> = [
  {
    label: 'сроки и темп',
    keywords: [/срок/i, /дедлайн/i, /время/i, /быстр/i, /затян/i]
  },
  {
    label: 'деньги и условия оплаты',
    keywords: [/оплат/i, /деньг/i, /бюджет/i, /стоим/i, /сумм/i]
  },
  {
    label: 'формат работы и роли',
    keywords: [/формат/i, /роль/i, /обязан/i, /ответствен/i, /задач/i]
  },
  {
    label: 'границы и уважительное общение',
    keywords: [/границ/i, /тон/i, /уваж/i, /общен/i, /конфликт/i]
  },
  {
    label: 'качество и ожидаемый результат',
    keywords: [/качеств/i, /результат/i, /ожидан/i, /итог/i]
  }
];

export interface ActionExecutionContext {
  correlation_id: string | null;
  channel: TransportChannel;
  idempotency_key: string;
  action_type: string;
  case_id: string | null;
  participant_id: string | null;
  payload: unknown;
}

interface ActionExecutionMeta {
  session_state: SessionState | null;
  proposal_set_version: number | null;
  round_number: number | null;
}

export interface ProblemSynthesisView {
  focus: string;
  shared_points: string;
  divergence: string;
}

export class ProtocolGatewayService {
  /**
   * Phase-specific alias:
   * "problem statement" is currently persisted in intake `facts` to avoid schema churn
   * before synthesis is enabled.
   */
  private static readonly PROBLEM_STATEMENT_FIELD = 'facts' as const;

  constructor(
    private readonly mediationService: MediationService,
    private readonly intakeService: IntakeService,
    private readonly synthesisService: SynthesisService,
    private readonly proposalService: ProposalGenerationService,
    private readonly negotiationService: NegotiationService,
    private readonly sessionRepository: SessionRepository,
    private readonly proposalSetRepository: ProposalSetRepository,
    private readonly trackingRepository: ProtocolTrackingRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: AppLogger = createNoopLogger()
  ) {}

  async createSession(
    ctx: ActionExecutionContext,
    telegramUserId: string
  ): Promise<{ session_id: string; invite_token: string; state: string }> {
    return this.executeIdempotent(ctx, async () => {
      const created = await this.mediationService.createSession(telegramUserId);
      return {
        session_id: created.session.id,
        invite_token: created.inviteToken,
        state: created.session.state
      };
    });
  }

  async joinSession(
    ctx: ActionExecutionContext,
    telegramUserId: string,
    inviteToken: string
  ): Promise<{ session_id: string; state: string }> {
    return this.executeIdempotent(ctx, async () => {
      const session = await this.mediationService.joinSessionByInviteToken(inviteToken, telegramUserId);
      return {
        session_id: session.id,
        state: session.state
      };
    });
  }

  async giveConsent(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<{ session_id: string; state: string }> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      const session = await this.mediationService.grantConsent(sessionId, telegramUserId);
      return {
        session_id: session.id,
        state: session.state
      };
    });
  }

  async resumeIntake(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<IntakeView> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      return this.intakeService.startOrResume(sessionId, telegramUserId);
    });
  }

  async confirmSummary(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<IntakeView> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      const privateData = await this.intakeService.getPrivateIntakeData(sessionId, telegramUserId);
      if (!privateData.view.generatedSummary) {
        throw new IntakeValidationError('No generated summary available for confirmation.');
      }

      return this.intakeService.confirmSummary({
        sessionId,
        telegramUserId,
        summary: privateData.view.generatedSummary,
        expectedVersion: privateData.view.version
      });
    });
  }

  async reopenIntake(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<IntakeView> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      const privateData = await this.intakeService.getPrivateIntakeData(sessionId, telegramUserId);
      return this.intakeService.reopenIntake({
        sessionId,
        telegramUserId,
        expectedVersion: privateData.view.version
      });
    });
  }

  async submitProblemDefinition(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string,
    description: string
  ): Promise<{ recorded_text: string }> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      const intake = await this.intakeService.startOrResume(sessionId, telegramUserId);
      const text = description.trim();
      if (!text) {
        throw new IntakeValidationError('Problem description cannot be empty.');
      }

      await this.intakeService.submitFieldAnswer({
        sessionId,
        telegramUserId,
        field: ProtocolGatewayService.PROBLEM_STATEMENT_FIELD,
        rawValue: text,
        expectedVersion: intake.version
      });

      return { recorded_text: text };
    });
  }

  async buildProblemSynthesis(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<ProblemSynthesisView> {
    return this.executeIdempotent(ctx, async () => {
      const session = await this.requireParticipant(sessionId, telegramUserId);
      if (session.participants.length !== 2) {
        throw new IntakeValidationError('Synthesis requires two participants.');
      }

      const statements: string[] = [];
      for (const participant of session.participants) {
        const privateData = await this.intakeService.getPrivateIntakeData(
          sessionId,
          participant.telegramUserId
        );
        const statement =
          privateData.view.fields[ProtocolGatewayService.PROBLEM_STATEMENT_FIELD].rawValue?.trim() ??
          '';
        if (!statement) {
          throw new IntakeValidationError('Synthesis requires confirmed problem statements from both participants.');
        }
        statements.push(statement);
      }

      return buildNeutralProblemSynthesis(statements[0], statements[1]);
    });
  }

  async submitProblemSynthesisClarification(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string,
    clarification: string
  ): Promise<{ saved: true }> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      await this.intakeService.savePrivateProblemClarification(
        sessionId,
        telegramUserId,
        clarification
      );
      return { saved: true };
    });
  }

  async generateProposals(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<ProposalSet> {
    return this.executeIdempotent(ctx, async () => {
      const session = await this.requireParticipant(sessionId, telegramUserId);
      if (session.state === SessionStates.READY_FOR_SYNTHESIS) {
        await this.synthesisService.synthesizeCase(sessionId);
      } else if (
        session.state === SessionStates.PROPOSALS_GENERATED ||
        session.state === SessionStates.NEGOTIATION_IN_PROGRESS ||
        session.state === SessionStates.AGREEMENT_REACHED ||
        session.state === SessionStates.PARTIAL_AGREEMENT ||
        session.state === SessionStates.DEADLOCK ||
        session.state === SessionStates.ABANDONED
      ) {
        const existing = await this.proposalSetRepository.findLatestByCaseId(sessionId);
        if (existing) {
          return existing;
        }
      }

      try {
        return await this.proposalService.generateLatest(sessionId);
      } catch (error) {
        if (
          error instanceof DomainError &&
          error.code === 'PROPOSAL_PRECONDITION_FAILED' &&
          session.state === SessionStates.READY_FOR_SYNTHESIS
        ) {
          throw new SynthesisPreconditionError(error.message);
        }
        throw error;
      }
    });
  }

  async selectPreferred(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string,
    variantType: ProposalVariantType
  ): Promise<SubmitNegotiationActionsResult> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      return this.negotiationService.submitActions({
        session_id: sessionId,
        telegram_user_id: telegramUserId,
        actions: [{ type: NegotiationActionTypes.SELECT_PREFERRED, variant_type: variantType }]
      });
    });
  }

  async acceptProposal(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string,
    variantType: ProposalVariantType
  ): Promise<SubmitNegotiationActionsResult> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      return this.negotiationService.submitActions({
        session_id: sessionId,
        telegram_user_id: telegramUserId,
        actions: [{ type: NegotiationActionTypes.ACCEPT, variant_type: variantType }]
      });
    });
  }

  async rejectProposal(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string,
    variantType: ProposalVariantType
  ): Promise<SubmitNegotiationActionsResult> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      return this.negotiationService.submitActions({
        session_id: sessionId,
        telegram_user_id: telegramUserId,
        actions: [{ type: NegotiationActionTypes.REJECT, variant_type: variantType }]
      });
    });
  }

  async suggestEdit(
    ctx: ActionExecutionContext,
    input: {
      session_id: string;
      telegram_user_id: string;
      variant_type: ProposalVariantType;
      clause_id: string;
      operation: SuggestEditOperation;
      proposed_value: string | null;
    }
  ): Promise<SubmitNegotiationActionsResult> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(input.session_id, input.telegram_user_id);
      return this.negotiationService.submitActions({
        session_id: input.session_id,
        telegram_user_id: input.telegram_user_id,
        actions: [
          {
            type: NegotiationActionTypes.SUGGEST_EDIT,
            variant_type: input.variant_type,
            clause_id: input.clause_id,
            operation: input.operation,
            proposed_value: input.proposed_value
          }
        ]
      });
    });
  }

  async getSessionStatus(sessionId: string, telegramUserId: string) {
    return this.requireParticipant(sessionId, telegramUserId);
  }

  async getLatestProposalSet(sessionId: string, telegramUserId: string) {
    await this.requireParticipant(sessionId, telegramUserId);
    return this.proposalSetRepository.findLatestByCaseId(sessionId);
  }

  async getNegotiationStatus(sessionId: string, telegramUserId: string) {
    return this.negotiationService.getView(sessionId, telegramUserId);
  }

  private async requireParticipant(sessionId: string, telegramUserId: string) {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    const isParticipant = session.participants.some(
      (participant) => participant.telegramUserId === telegramUserId
    );
    if (!isParticipant) {
      throw new TransportAccessDeniedError();
    }

    return session;
  }

  private async executeIdempotent<T>(
    ctx: ActionExecutionContext,
    execute: () => Promise<T>
  ): Promise<T> {
    this.logger.info(
      {
        correlation_id: ctx.correlation_id,
        channel: ctx.channel,
        action_type: ctx.action_type,
        case_id: ctx.case_id,
        participant_id: ctx.participant_id
      },
      'protocol.action.received'
    );

    const existing = await this.trackingRepository.findIdempotencyRecord(ctx.idempotency_key);
    if (existing) {
      const meta = this.extractMeta(existing.response_json);
      this.logger.info(
        {
          correlation_id: ctx.correlation_id,
          idempotency_key: ctx.idempotency_key,
          action_type: ctx.action_type
        },
        'protocol.action.replayed.exact_key'
      );
      await this.trackEvent({
        ctx,
        outcome: ProtocolEventOutcomes.NO_OP,
        errorCode: null,
        meta
      });
      return existing.response_json as T;
    }

    const payloadHash = this.hashPayload(ctx.payload);
    const recent = await this.trackingRepository.findRecentByFingerprint({
      channel: ctx.channel,
      case_id: ctx.case_id,
      participant_id: ctx.participant_id,
      action_type: ctx.action_type,
      payload_hash: payloadHash,
      since: new Date(this.clock.now().getTime() - RETRY_WINDOW_MS)
    });

    if (recent) {
      const meta = this.extractMeta(recent.response_json);
      this.logger.info(
        {
          correlation_id: ctx.correlation_id,
          action_type: ctx.action_type,
          payload_hash: payloadHash
        },
        'protocol.action.replayed.fingerprint'
      );
      await this.trackEvent({
        ctx,
        outcome: ProtocolEventOutcomes.NO_OP,
        errorCode: null,
        meta
      });
      return recent.response_json as T;
    }

    try {
      const response = await execute();
      const meta = this.extractMeta(response);
      const caseId = ctx.case_id ?? this.extractCaseId(response);

      const record: IdempotencyRecord = {
        key: ctx.idempotency_key,
        channel: ctx.channel,
        case_id: caseId,
        participant_id: ctx.participant_id,
        action_type: ctx.action_type,
        payload_hash: payloadHash,
        response_json: response,
        created_at: this.clock.now()
      };
      await this.trackingRepository.saveIdempotencyRecord(record);

      await this.trackEvent({
        ctx: { ...ctx, case_id: caseId },
        outcome: ProtocolEventOutcomes.ACCEPTED,
        errorCode: null,
        meta
      });

      this.logger.info(
        {
          correlation_id: ctx.correlation_id,
          action_type: ctx.action_type,
          case_id: caseId,
          session_state: meta.session_state,
          proposal_set_version: meta.proposal_set_version,
          round_number: meta.round_number
        },
        'protocol.action.accepted'
      );

      return response;
    } catch (error) {
      this.logger.warn(
        {
          correlation_id: ctx.correlation_id,
          action_type: ctx.action_type,
          code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR'
        },
        'protocol.action.rejected'
      );
      await this.trackEvent({
        ctx,
        outcome: ProtocolEventOutcomes.ERROR,
        errorCode: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
        meta: {
          session_state: null,
          proposal_set_version: null,
          round_number: null
        }
      });
      throw error;
    }
  }

  private async trackEvent(input: {
    ctx: ActionExecutionContext;
    outcome: (typeof ProtocolEventOutcomes)[keyof typeof ProtocolEventOutcomes];
    errorCode: string | null;
    meta: ActionExecutionMeta;
  }): Promise<void> {
    await this.trackingRepository.saveProtocolEvent({
      id: this.idGenerator.nextId(),
      case_id: input.ctx.case_id,
      participant_id: input.ctx.participant_id,
      action_type: input.ctx.action_type,
      idempotency_key: input.ctx.idempotency_key,
      channel: input.ctx.channel,
      outcome: input.outcome,
      error_code: input.errorCode,
      session_state: input.meta.session_state,
      proposal_set_version: input.meta.proposal_set_version,
      round_number: input.meta.round_number,
      created_at: this.clock.now()
    });
  }

  private extractMeta(response: unknown): ActionExecutionMeta {
    if (!response || typeof response !== 'object') {
      return {
        session_state: null,
        proposal_set_version: null,
        round_number: null
      };
    }

    const record = response as Record<string, unknown>;
    const sessionState =
      (typeof record.state === 'string' ? record.state : null) ??
      (typeof record.session_state === 'string' ? record.session_state : null);

    const proposalSetVersion =
      (typeof record.proposal_set_version === 'number'
        ? record.proposal_set_version
        : null) ?? (typeof record.version === 'number' ? record.version : null);

    const roundNumber =
      (record.round &&
      typeof record.round === 'object' &&
      typeof (record.round as Record<string, unknown>).round_number === 'number'
        ? ((record.round as Record<string, unknown>).round_number as number)
        : null) ??
      (typeof record.current_round_number === 'number' ? record.current_round_number : null);

    return {
      session_state: sessionState as SessionState | null,
      proposal_set_version: proposalSetVersion,
      round_number: roundNumber
    };
  }

  private extractCaseId(response: unknown): string | null {
    if (!response || typeof response !== 'object') {
      return null;
    }

    const record = response as Record<string, unknown>;
    if (typeof record.session_id === 'string') {
      return record.session_id;
    }
    if (typeof record.case_id === 'string') {
      return record.case_id;
    }
    return null;
  }

  private hashPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
  }
}

const extractSynthesisThemes = (statement: string): string[] => {
  const normalized = statement.toLowerCase();
  const found = synthesisThemes
    .filter((theme) => theme.keywords.some((pattern) => pattern.test(normalized)))
    .map((theme) => theme.label);

  if (found.length > 0) {
    return found;
  }

  return ['условия взаимодействия и итоговые договорённости'];
};

const asHumanList = (values: string[]): string =>
  values.length <= 1
    ? values[0] ?? ''
    : `${values.slice(0, -1).join(', ')} и ${values[values.length - 1]}`;

const buildNeutralProblemSynthesis = (
  participantAStatement: string,
  participantBStatement: string
): ProblemSynthesisView => {
  const aThemes = new Set(extractSynthesisThemes(participantAStatement));
  const bThemes = new Set(extractSynthesisThemes(participantBStatement));

  const union = [...new Set([...aThemes, ...bThemes])];
  const shared = union.filter((theme) => aThemes.has(theme) && bThemes.has(theme));
  const onlyA = union.filter((theme) => aThemes.has(theme) && !bThemes.has(theme));
  const onlyB = union.filter((theme) => bThemes.has(theme) && !aThemes.has(theme));

  const focus = `согласовать ${asHumanList(union)}.`;
  const sharedPoints =
    shared.length > 0
      ? `обе стороны отмечают важность: ${asHumanList(shared)}.`
      : 'обе стороны хотят снизить напряжение и зафиксировать понятные правила.';

  let divergence = 'пока различаются акценты по деталям и приоритетам.';
  if (onlyA.length > 0 && onlyB.length > 0) {
    divergence = `есть разные акценты: часть ожиданий про ${asHumanList(onlyA)}, а часть — про ${asHumanList(onlyB)}.`;
  } else if (onlyA.length > 0 || onlyB.length > 0) {
    const unique = onlyA.length > 0 ? onlyA : onlyB;
    divergence = `нужно отдельно согласовать ожидания по теме: ${asHumanList(unique)}.`;
  }

  return {
    focus,
    shared_points: sharedPoints,
    divergence
  };
};
