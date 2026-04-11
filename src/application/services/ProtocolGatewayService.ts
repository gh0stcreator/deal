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
import { SynthesisReviewRepository } from '../ports/SynthesisReviewRepository.js';
import { IssueResolutionRepository } from '../ports/IssueResolutionRepository.js';
import { DraftAgreementRepository } from '../ports/DraftAgreementRepository.js';
import {
  IdempotencyRecord,
  ProtocolEventOutcomes,
  TransportChannel
} from '../../domain/protocol/types.js';
import { ProposalSet, ProposalVariantType } from '../../domain/proposal/types.js';
import { SessionNotFoundError } from '../../domain/session/errors.js';
import { MediationSession, SessionState, SessionStates } from '../../domain/session/types.js';
import { IntakeValidationError } from '../../domain/intake/errors.js';
import { IntakeField } from '../../domain/intake/types.js';
import { SynthesisPreconditionError } from '../../domain/synthesis/errors.js';
import {
  NegotiationActionTypes,
  SuggestEditOperation
} from '../../domain/negotiation/types.js';
import { TransportAccessDeniedError } from '../../domain/protocol/errors.js';
import { DomainError } from '../../domain/session/errors.js';
import { AppLogger, createNoopLogger } from '../ports/AppLogger.js';
import {
  ProblemSynthesisSnapshot,
  SynthesisReactionTypes,
  SynthesisReactionType
} from '../../domain/synthesis/types.js';
import {
  IssueLoopStatuses,
  IssueReactionType,
  IssueReactionTypes,
  IssueResolutionLoop,
  IssueResolutionOption
} from '../../domain/issue/types.js';
import {
  DraftAgreement,
  DraftAgreementOutcomeType,
  DraftAgreementOutcomeTypes,
  DraftAgreementResponseType,
  DraftAgreementResponseTypes
} from '../../domain/agreement/types.js';

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
  shared_goal: string;
  agreement_points: string[];
  tension_points: string[];
  primary_tension_point: string;
  side_a_interest: string;
  side_b_interest: string;
  side_a_constraint: string;
  side_b_constraint: string;
  possible_zone_of_agreement: string;
}

export interface ProblemSynthesisEnvelope {
  synthesis_version: number;
  synthesis: ProblemSynthesisView;
}

export interface ProblemDefinitionReadiness {
  participant_count: number;
  confirmed_count: number;
  statement_count: number;
  both_ready: boolean;
}

export interface ProblemSynthesisReviewSummary {
  synthesis_version: number | null;
  review_summary: 'both_confirmed' | 'one_confirmed_one_clarified' | 'both_clarified' | 'incomplete';
}

export interface ProblemSynthesisDogfoodExport {
  session_id: string;
  synthesis_version: number | null;
  review_summary: ProblemSynthesisReviewSummary['review_summary'];
  confirm_count: number;
  clarify_count: number;
}

export interface IssueResolutionLoopView {
  loop_version: number;
  synthesis_version: number;
  issue_title: string;
  side_a_priority: string;
  side_b_priority: string;
  issue_constraints: string[];
  options: Array<{
    option_id: string;
    title: string;
    description: string;
    tradeoff_note: string;
  }>;
  option_tradeoffs: string[];
}

export interface IssueResolutionSummaryView {
  loop_version: number;
  status: (typeof IssueLoopStatuses)[keyof typeof IssueLoopStatuses];
  workable_option_id: string | null;
  option_reactions: Array<{
    option_id: string;
    accept_count: number;
    reject_count: number;
    change_request_count: number;
  }>;
}

export interface DraftAgreementView {
  draft_version: number;
  loop_version: number;
  source_option_id: string;
  agreement_title: string;
  agreed_actions: string[];
  boundaries: string[];
  conditions: string[];
  fallback_rule: string;
  review_point: string;
}

export interface DraftAgreementDecisionView {
  draft_version: number;
  outcome: DraftAgreementOutcomeType | null;
  confirm_count: number;
  reject_count: number;
  change_request_count: number;
}

export interface StructuredIntakeAnswerInput {
  field: IntakeField;
  value: string;
}

class NoopSynthesisReviewRepository implements SynthesisReviewRepository {
  async findLatestProblemSynthesis(): Promise<ProblemSynthesisSnapshot | null> {
    return null;
  }

  async saveProblemSynthesis(): Promise<void> {}

  async saveOrUpdateReviewSignal(): Promise<void> {}

  async listReviewSignals(): Promise<never[]> {
    return [];
  }
}

class NoopIssueResolutionRepository implements IssueResolutionRepository {
  async findLatestLoopByCaseId(): Promise<IssueResolutionLoop | null> {
    return null;
  }

  async saveLoop(): Promise<void> {}

  async listLoopsByCaseId(): Promise<IssueResolutionLoop[]> {
    return [];
  }

  async saveOrUpdateReaction(): Promise<void> {}

  async listReactions(): Promise<never[]> {
    return [];
  }
}

class NoopDraftAgreementRepository implements DraftAgreementRepository {
  async findLatestByCaseId(): Promise<DraftAgreement | null> {
    return null;
  }

  async saveDraft(): Promise<void> {}

  async listByCaseId(): Promise<DraftAgreement[]> {
    return [];
  }

  async saveOrUpdateResponse(): Promise<void> {}

  async listResponses(): Promise<never[]> {
    return [];
  }

  async upsertOutcome(): Promise<void> {}

  async findOutcome(): Promise<null> {
    return null;
  }
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
    private readonly logger: AppLogger = createNoopLogger(),
    private readonly synthesisReviewRepository: SynthesisReviewRepository = new NoopSynthesisReviewRepository(),
    private readonly issueResolutionRepository: IssueResolutionRepository = new NoopIssueResolutionRepository(),
    private readonly draftAgreementRepository: DraftAgreementRepository = new NoopDraftAgreementRepository()
  ) {}

  async createSession(
    ctx: ActionExecutionContext,
    telegramUserId: string,
    problemTopic?: string
  ): Promise<{ session_id: string; invite_token: string; state: string }> {
    return this.executeIdempotent(ctx, async () => {
      const created = problemTopic
        ? await this.mediationService.createSessionWithTopic(telegramUserId, problemTopic)
        : await this.mediationService.createSession(telegramUserId);
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

  async getIntakeProgress(sessionId: string, telegramUserId: string): Promise<IntakeView> {
    await this.requireParticipant(sessionId, telegramUserId);
    return this.intakeService.startOrResume(sessionId, telegramUserId);
  }

  async submitIntakeAnswers(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string,
    answers: StructuredIntakeAnswerInput[]
  ): Promise<IntakeView> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      if (answers.length === 0) {
        throw new IntakeValidationError('At least one intake answer is required.');
      }

      let view = await this.intakeService.startOrResume(sessionId, telegramUserId);
      for (const answer of answers) {
        const rawValue = answer.value.trim();
        if (!rawValue) {
          throw new IntakeValidationError('Intake answer cannot be empty.');
        }
        view = await this.intakeService.submitFieldAnswer({
          sessionId,
          telegramUserId,
          field: answer.field,
          rawValue,
          expectedVersion: view.version
        });
      }

      return view;
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

  async confirmProblemDefinition(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<{ session_id: string; confirmed: true }> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      const privateData = await this.intakeService.getPrivateIntakeData(sessionId, telegramUserId);
      const statement =
        privateData.view.fields[ProtocolGatewayService.PROBLEM_STATEMENT_FIELD].rawValue?.trim() ??
        '';
      if (!statement) {
        throw new IntakeValidationError('Problem statement is missing for this participant.');
      }

      return { session_id: sessionId, confirmed: true };
    });
  }

  async getProblemDefinitionReadiness(
    sessionId: string,
    telegramUserId: string
  ): Promise<ProblemDefinitionReadiness> {
    const session = await this.requireParticipant(sessionId, telegramUserId);
    const events = await this.trackingRepository.listProtocolEvents(sessionId);

    const confirmedParticipantIds = new Set(
      events
        .filter(
          (event) =>
            event.action_type === 'problem_confirm' &&
            event.outcome !== ProtocolEventOutcomes.ERROR &&
            Boolean(event.participant_id)
        )
        .map((event) => event.participant_id as string)
    );

    let statementCount = 0;
    for (const participant of session.participants) {
      try {
        const privateData = await this.intakeService.getPrivateIntakeData(
          sessionId,
          participant.telegramUserId
        );
        const statement =
          privateData.view.fields[ProtocolGatewayService.PROBLEM_STATEMENT_FIELD].rawValue?.trim() ??
          '';
        if (statement) {
          statementCount += 1;
        }
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'INTAKE_NOT_FOUND') {
          throw error;
        }
      }
    }

    const confirmedCount = session.participants.filter((participant) =>
      confirmedParticipantIds.has(participant.telegramUserId)
    ).length;

    return {
      participant_count: session.participants.length,
      confirmed_count: confirmedCount,
      statement_count: statementCount,
      both_ready:
        session.participants.length === 2 && confirmedCount === 2 && statementCount === 2
    };
  }

  async buildProblemSynthesis(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<ProblemSynthesisEnvelope> {
    return this.executeIdempotent(ctx, async () => {
      const session = await this.requireParticipant(sessionId, telegramUserId);
      if (session.participants.length !== 2) {
        throw new IntakeValidationError('Synthesis requires two participants.');
      }

      const partyA = session.participants.find((entry) => entry.role === 'PARTY_A');
      const partyB = session.participants.find((entry) => entry.role === 'PARTY_B');
      if (!partyA || !partyB) {
        throw new IntakeValidationError('Synthesis requires exactly two participants with explicit roles.');
      }

      const partyAData = await this.intakeService.getPrivateIntakeData(sessionId, partyA.telegramUserId);
      const partyBData = await this.intakeService.getPrivateIntakeData(sessionId, partyB.telegramUserId);
      if (partyAData.view.state !== 'COMPLETED' || partyBData.view.state !== 'COMPLETED') {
        throw new IntakeValidationError('Synthesis requires confirmed structured intake from both participants.');
      }

      const synthesis = buildStructuredProblemSynthesis(
        {
          facts: requireNormalized(partyAData.view.fields.facts.normalizedValue, 'party_a.facts'),
          tension: requireNormalized(
            partyAData.view.fields.interpretations.normalizedValue,
            'party_a.tension_point'
          ),
          interest: requireNormalized(
            partyAData.view.fields.interests.normalizedValue,
            'party_a.important_need_or_interest'
          ),
          constraint: requireNormalized(
            partyAData.view.fields.constraints.normalizedValue,
            'party_a.hard_constraint'
          ),
          desiredOutcome: requireNormalized(
            partyAData.view.fields.desired_outcome.normalizedValue,
            'party_a.desired_outcome'
          ),
          flexibility: requireNormalized(
            partyAData.view.fields.acceptable_concessions.normalizedValue,
            'party_a.acceptable_flexibility'
          )
        },
        {
          facts: requireNormalized(partyBData.view.fields.facts.normalizedValue, 'party_b.facts'),
          tension: requireNormalized(
            partyBData.view.fields.interpretations.normalizedValue,
            'party_b.tension_point'
          ),
          interest: requireNormalized(
            partyBData.view.fields.interests.normalizedValue,
            'party_b.important_need_or_interest'
          ),
          constraint: requireNormalized(
            partyBData.view.fields.constraints.normalizedValue,
            'party_b.hard_constraint'
          ),
          desiredOutcome: requireNormalized(
            partyBData.view.fields.desired_outcome.normalizedValue,
            'party_b.desired_outcome'
          ),
          flexibility: requireNormalized(
            partyBData.view.fields.acceptable_concessions.normalizedValue,
            'party_b.acceptable_flexibility'
          )
        }
      );
      const latest = await this.synthesisReviewRepository.findLatestProblemSynthesis(sessionId);
      const snapshot: ProblemSynthesisSnapshot = {
        id: this.idGenerator.nextId(),
        caseId: sessionId,
        version: latest ? latest.version + 1 : 1,
        focus: synthesis.shared_goal,
        sharedPoints: synthesis.agreement_points.join(' | '),
        divergence: synthesis.primary_tension_point,
        createdAt: this.clock.now()
      };
      await this.synthesisReviewRepository.saveProblemSynthesis(snapshot);

      return {
        synthesis_version: snapshot.version,
        synthesis
      };
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

  async recordProblemSynthesisReaction(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string,
    reactionType: 'confirm' | 'clarify'
  ): Promise<{ synthesis_version: number; reaction_type: 'confirm' | 'clarify' }> {
    return this.executeIdempotent(ctx, async () => {
      const { participant } = await this.requireParticipantRecord(sessionId, telegramUserId);
      const latest = await this.synthesisReviewRepository.findLatestProblemSynthesis(sessionId);
      if (!latest) {
        throw new IntakeValidationError('No synthesis available to review yet.');
      }

      const mappedReaction: SynthesisReactionType =
        reactionType === 'confirm' ? SynthesisReactionTypes.CONFIRM : SynthesisReactionTypes.CLARIFY;
      await this.synthesisReviewRepository.saveOrUpdateReviewSignal({
        id: this.idGenerator.nextId(),
        caseId: sessionId,
        participantId: participant.id,
        synthesisVersion: latest.version,
        reactionType: mappedReaction,
        createdAt: this.clock.now()
      });

      return {
        synthesis_version: latest.version,
        reaction_type: reactionType
      };
    });
  }

  async getProblemSynthesisReviewSummary(
    sessionId: string,
    telegramUserId: string
  ): Promise<ProblemSynthesisReviewSummary> {
    const details = await this.getProblemSynthesisReviewDetails(sessionId, telegramUserId);
    return {
      synthesis_version: details.synthesis_version,
      review_summary: details.review_summary
    };
  }

  async getProblemSynthesisDogfoodExport(
    sessionId: string,
    telegramUserId: string
  ): Promise<ProblemSynthesisDogfoodExport> {
    const details = await this.getProblemSynthesisReviewDetails(sessionId, telegramUserId);
    return {
      session_id: sessionId,
      synthesis_version: details.synthesis_version,
      review_summary: details.review_summary,
      confirm_count: details.confirm_count,
      clarify_count: details.clarify_count
    };
  }

  async generateIssueResolutionLoop(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<IssueResolutionLoopView> {
    return this.executeIdempotent(ctx, async () => {
      const { session, participant } = await this.requireParticipantRecord(sessionId, telegramUserId);
      const latestSynthesis = await this.synthesisReviewRepository.findLatestProblemSynthesis(sessionId);
      if (!latestSynthesis) {
        throw new IntakeValidationError('Issue loop requires synthesis first.');
      }

      const signals = await this.synthesisReviewRepository.listReviewSignals(
        sessionId,
        latestSynthesis.version
      );
      const participantSignals = new Set(signals.map((signal) => signal.participantId));
      const everyParticipantReacted = session.participants.every((entry) =>
        participantSignals.has(entry.id)
      );
      if (!everyParticipantReacted) {
        throw new IntakeValidationError(
          'Issue loop requires synthesis feedback from both participants.'
        );
      }

      const partyA = session.participants.find((entry) => entry.role === 'PARTY_A');
      const partyB = session.participants.find((entry) => entry.role === 'PARTY_B');
      if (!partyA || !partyB) {
        throw new IntakeValidationError('Issue loop requires two participants with explicit roles.');
      }

      const partyAData = await this.intakeService.getPrivateIntakeData(
        sessionId,
        partyA.telegramUserId
      );
      const partyBData = await this.intakeService.getPrivateIntakeData(
        sessionId,
        partyB.telegramUserId
      );
      if (partyAData.view.state !== 'COMPLETED' || partyBData.view.state !== 'COMPLETED') {
        throw new IntakeValidationError('Issue loop requires completed structured intake for both sides.');
      }

      const generated = buildIssueResolutionLoop({
        synthesisVersion: latestSynthesis.version,
        primaryTensionPoint: latestSynthesis.divergence,
        sharedGoal: latestSynthesis.focus,
        sideA: {
          interest: requireNormalized(
            partyAData.view.fields.interests.normalizedValue,
            'party_a.interests'
          ),
          constraint: requireNormalized(
            partyAData.view.fields.constraints.normalizedValue,
            'party_a.constraints'
          ),
          outcome: requireNormalized(
            partyAData.view.fields.desired_outcome.normalizedValue,
            'party_a.desired_outcome'
          ),
          flexibility: requireNormalized(
            partyAData.view.fields.acceptable_concessions.normalizedValue,
            'party_a.acceptable_flexibility'
          )
        },
        sideB: {
          interest: requireNormalized(
            partyBData.view.fields.interests.normalizedValue,
            'party_b.interests'
          ),
          constraint: requireNormalized(
            partyBData.view.fields.constraints.normalizedValue,
            'party_b.constraints'
          ),
          outcome: requireNormalized(
            partyBData.view.fields.desired_outcome.normalizedValue,
            'party_b.desired_outcome'
          ),
          flexibility: requireNormalized(
            partyBData.view.fields.acceptable_concessions.normalizedValue,
            'party_b.acceptable_flexibility'
          )
        }
      });

      const latestLoop = await this.issueResolutionRepository.findLatestLoopByCaseId(sessionId);
      const loop: IssueResolutionLoop = {
        id: this.idGenerator.nextId(),
        caseId: sessionId,
        version: latestLoop ? latestLoop.version + 1 : 1,
        synthesisVersion: latestSynthesis.version,
        issueTitle: generated.issue_title,
        sideAPriority: generated.side_a_priority,
        sideBPriority: generated.side_b_priority,
        issueConstraints: generated.issue_constraints,
        options: generated.options,
        optionTradeoffs: generated.option_tradeoffs,
        createdAt: this.clock.now()
      };
      await this.issueResolutionRepository.saveLoop(loop);

      return {
        loop_version: loop.version,
        synthesis_version: loop.synthesisVersion,
        issue_title: loop.issueTitle,
        side_a_priority: loop.sideAPriority,
        side_b_priority: loop.sideBPriority,
        issue_constraints: loop.issueConstraints,
        options: loop.options,
        option_tradeoffs: loop.optionTradeoffs
      };
    });
  }

  async submitIssueOptionReaction(
    ctx: ActionExecutionContext,
    input: {
      session_id: string;
      telegram_user_id: string;
      loop_version: number;
      option_id: string;
      reaction_type: IssueReactionType;
      change_request?: string | null;
    }
  ): Promise<IssueResolutionSummaryView> {
    return this.executeIdempotent(ctx, async () => {
      const { session, participant } = await this.requireParticipantRecord(
        input.session_id,
        input.telegram_user_id
      );
      const loop = (await this.issueResolutionRepository.listLoopsByCaseId(input.session_id)).find(
        (entry) => entry.version === input.loop_version
      );
      if (!loop) {
        throw new IntakeValidationError('Issue loop was not found.');
      }

      const optionExists = loop.options.some((option) => option.option_id === input.option_id);
      if (!optionExists) {
        throw new IntakeValidationError('Issue option was not found.');
      }

      const changeRequest = input.change_request?.trim() ?? null;
      if (input.reaction_type === IssueReactionTypes.REQUEST_CHANGE && !changeRequest) {
        throw new IntakeValidationError('Change request cannot be empty.');
      }

      await this.issueResolutionRepository.saveOrUpdateReaction({
        id: this.idGenerator.nextId(),
        caseId: input.session_id,
        loopVersion: input.loop_version,
        participantId: participant.id,
        optionId: input.option_id,
        reactionType: input.reaction_type,
        changeRequest: input.reaction_type === IssueReactionTypes.REQUEST_CHANGE ? changeRequest : null,
        createdAt: this.clock.now()
      });

      return this.buildIssueSummary(session, loop);
    });
  }

  async getIssueResolutionSummary(
    sessionId: string,
    telegramUserId: string
  ): Promise<IssueResolutionSummaryView> {
    const session = await this.requireParticipant(sessionId, telegramUserId);
    const loop = await this.issueResolutionRepository.findLatestLoopByCaseId(sessionId);
    if (!loop) {
      throw new IntakeValidationError('Issue loop is not ready yet.');
    }
    return this.buildIssueSummary(session, loop);
  }

  async generateDraftAgreement(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<DraftAgreementView> {
    return this.executeIdempotent(ctx, async () => {
      const { session } = await this.requireParticipantRecord(sessionId, telegramUserId);
      if (session.participants.length !== 2) {
        throw new IntakeValidationError('Draft agreement requires two participants.');
      }

      const loop = await this.issueResolutionRepository.findLatestLoopByCaseId(sessionId);
      if (!loop) {
        throw new IntakeValidationError('Issue loop is not ready yet.');
      }
      const reactions = await this.issueResolutionRepository.listReactions(sessionId, loop.version);
      const source = resolveDraftSource(loop, reactions);
      if (!source) {
        throw new IntakeValidationError(
          'Draft agreement can be generated only after converged option signals.'
        );
      }

      const partyA = session.participants.find((entry) => entry.role === 'PARTY_A');
      const partyB = session.participants.find((entry) => entry.role === 'PARTY_B');
      if (!partyA || !partyB) {
        throw new IntakeValidationError('Draft agreement requires explicit PARTY_A/PARTY_B roles.');
      }
      const partyAData = await this.intakeService.getPrivateIntakeData(sessionId, partyA.telegramUserId);
      const partyBData = await this.intakeService.getPrivateIntakeData(sessionId, partyB.telegramUserId);
      if (partyAData.view.state !== 'COMPLETED' || partyBData.view.state !== 'COMPLETED') {
        throw new IntakeValidationError('Draft agreement requires confirmed intake from both sides.');
      }

      const sourceOption = loop.options.find((option) => option.option_id === source.optionId);
      if (!sourceOption) {
        throw new IntakeValidationError('Source option not found for agreement.');
      }

      const nextVersion = (await this.draftAgreementRepository.findLatestByCaseId(sessionId))?.version ?? 0;
      const draft = buildDraftAgreement({
        id: this.idGenerator.nextId(),
        caseId: sessionId,
        version: nextVersion + 1,
        loopVersion: loop.version,
        sourceOption,
        sideA: {
          desiredOutcome: requireNormalized(
            partyAData.view.fields.desired_outcome.normalizedValue,
            'party_a.desired_outcome'
          ),
          constraint: requireNormalized(
            partyAData.view.fields.constraints.normalizedValue,
            'party_a.constraints'
          ),
          flexibility: requireNormalized(
            partyAData.view.fields.acceptable_concessions.normalizedValue,
            'party_a.acceptable_concessions'
          )
        },
        sideB: {
          desiredOutcome: requireNormalized(
            partyBData.view.fields.desired_outcome.normalizedValue,
            'party_b.desired_outcome'
          ),
          constraint: requireNormalized(
            partyBData.view.fields.constraints.normalizedValue,
            'party_b.constraints'
          ),
          flexibility: requireNormalized(
            partyBData.view.fields.acceptable_concessions.normalizedValue,
            'party_b.acceptable_concessions'
          )
        },
        mergedChangeRequest: source.mergedChangeRequest,
        createdAt: this.clock.now()
      });
      await this.draftAgreementRepository.saveDraft(draft);

      return mapDraftAgreement(draft);
    });
  }

  async submitDraftAgreementResponse(
    ctx: ActionExecutionContext,
    input: {
      session_id: string;
      telegram_user_id: string;
      draft_version: number;
      response_type: DraftAgreementResponseType;
      change_request?: string | null;
    }
  ): Promise<DraftAgreementDecisionView> {
    return this.executeIdempotent(ctx, async () => {
      const { session, participant } = await this.requireParticipantRecord(
        input.session_id,
        input.telegram_user_id
      );
      const draft = (await this.draftAgreementRepository.listByCaseId(input.session_id)).find(
        (entry) => entry.version === input.draft_version
      );
      if (!draft) {
        throw new IntakeValidationError('Draft agreement was not found.');
      }

      const changeRequest = input.change_request?.trim() ?? null;
      if (input.response_type === DraftAgreementResponseTypes.REQUEST_CHANGE && !changeRequest) {
        throw new IntakeValidationError('Change request cannot be empty.');
      }

      await this.draftAgreementRepository.saveOrUpdateResponse({
        id: this.idGenerator.nextId(),
        caseId: input.session_id,
        draftVersion: input.draft_version,
        participantId: participant.id,
        responseType: input.response_type,
        changeRequest: input.response_type === DraftAgreementResponseTypes.REQUEST_CHANGE ? changeRequest : null,
        createdAt: this.clock.now()
      });

      const summary = await this.buildDraftAgreementDecisionSummary(session.id, input.draft_version);
      if (summary.outcome) {
        await this.draftAgreementRepository.upsertOutcome({
          id: this.idGenerator.nextId(),
          caseId: session.id,
          draftVersion: input.draft_version,
          outcome: summary.outcome,
          createdAt: this.clock.now()
        });
      }
      return summary;
    });
  }

  async regenerateDraftAgreement(
    ctx: ActionExecutionContext,
    sessionId: string,
    telegramUserId: string
  ): Promise<DraftAgreementView> {
    return this.executeIdempotent(ctx, async () => {
      await this.requireParticipant(sessionId, telegramUserId);
      const latestDraft = await this.draftAgreementRepository.findLatestByCaseId(sessionId);
      if (!latestDraft) {
        throw new IntakeValidationError('Draft agreement is not ready yet.');
      }
      const responses = await this.draftAgreementRepository.listResponses(sessionId, latestDraft.version);
      const mergedChangeRequest = responses
        .filter((entry) => entry.responseType === DraftAgreementResponseTypes.REQUEST_CHANGE)
        .map((entry) => entry.changeRequest?.trim())
        .filter((entry): entry is string => Boolean(entry))
        .join('; ')
        .trim();
      if (!mergedChangeRequest) {
        throw new IntakeValidationError('No change request found for regeneration.');
      }

      const loop = (await this.issueResolutionRepository.listLoopsByCaseId(sessionId)).find(
        (entry) => entry.version === latestDraft.loopVersion
      );
      if (!loop) {
        throw new IntakeValidationError('Issue loop was not found for regeneration.');
      }
      const sourceOption = loop.options.find((entry) => entry.option_id === latestDraft.sourceOptionId);
      if (!sourceOption) {
        throw new IntakeValidationError('Source option was not found for regeneration.');
      }
      const session = await this.requireParticipant(sessionId, telegramUserId);
      const partyA = session.participants.find((entry) => entry.role === 'PARTY_A');
      const partyB = session.participants.find((entry) => entry.role === 'PARTY_B');
      if (!partyA || !partyB) {
        throw new IntakeValidationError('Draft regeneration requires two participants.');
      }
      const partyAData = await this.intakeService.getPrivateIntakeData(sessionId, partyA.telegramUserId);
      const partyBData = await this.intakeService.getPrivateIntakeData(sessionId, partyB.telegramUserId);

      const draft = buildDraftAgreement({
        id: this.idGenerator.nextId(),
        caseId: sessionId,
        version: latestDraft.version + 1,
        loopVersion: latestDraft.loopVersion,
        sourceOption,
        sideA: {
          desiredOutcome: requireNormalized(
            partyAData.view.fields.desired_outcome.normalizedValue,
            'party_a.desired_outcome'
          ),
          constraint: requireNormalized(
            partyAData.view.fields.constraints.normalizedValue,
            'party_a.constraints'
          ),
          flexibility: requireNormalized(
            partyAData.view.fields.acceptable_concessions.normalizedValue,
            'party_a.acceptable_concessions'
          )
        },
        sideB: {
          desiredOutcome: requireNormalized(
            partyBData.view.fields.desired_outcome.normalizedValue,
            'party_b.desired_outcome'
          ),
          constraint: requireNormalized(
            partyBData.view.fields.constraints.normalizedValue,
            'party_b.constraints'
          ),
          flexibility: requireNormalized(
            partyBData.view.fields.acceptable_concessions.normalizedValue,
            'party_b.acceptable_concessions'
          )
        },
        mergedChangeRequest,
        createdAt: this.clock.now()
      });
      await this.draftAgreementRepository.saveDraft(draft);
      return mapDraftAgreement(draft);
    });
  }

  async getLatestDraftAgreement(
    sessionId: string,
    telegramUserId: string
  ): Promise<DraftAgreementView> {
    await this.requireParticipant(sessionId, telegramUserId);
    const latest = await this.draftAgreementRepository.findLatestByCaseId(sessionId);
    if (!latest) {
      throw new IntakeValidationError('Draft agreement is not ready yet.');
    }
    return mapDraftAgreement(latest);
  }

  async getDraftAgreementDecision(
    sessionId: string,
    telegramUserId: string,
    draftVersion: number
  ): Promise<DraftAgreementDecisionView> {
    await this.requireParticipant(sessionId, telegramUserId);
    return this.buildDraftAgreementDecisionSummary(sessionId, draftVersion);
  }

  private async buildDraftAgreementDecisionSummary(
    sessionId: string,
    draftVersion: number
  ): Promise<DraftAgreementDecisionView> {
    const responses = await this.draftAgreementRepository.listResponses(sessionId, draftVersion);
    const confirmCount = responses.filter(
      (entry) => entry.responseType === DraftAgreementResponseTypes.CONFIRM
    ).length;
    const rejectCount = responses.filter(
      (entry) => entry.responseType === DraftAgreementResponseTypes.REJECT
    ).length;
    const changeCount = responses.filter(
      (entry) => entry.responseType === DraftAgreementResponseTypes.REQUEST_CHANGE
    ).length;

    let outcome: DraftAgreementOutcomeType | null = null;
    if (confirmCount >= 2) {
      outcome = DraftAgreementOutcomeTypes.AGREEMENT;
    } else if (rejectCount >= 2) {
      outcome = DraftAgreementOutcomeTypes.DEADLOCK;
    } else if (confirmCount >= 1 && (rejectCount >= 1 || changeCount >= 1)) {
      outcome = DraftAgreementOutcomeTypes.PARTIAL_AGREEMENT;
    }

    return {
      draft_version: draftVersion,
      outcome,
      confirm_count: confirmCount,
      reject_count: rejectCount,
      change_request_count: changeCount
    };
  }

  private async getProblemSynthesisReviewDetails(
    sessionId: string,
    telegramUserId: string
  ): Promise<
    ProblemSynthesisReviewSummary & {
      confirm_count: number;
      clarify_count: number;
    }
  > {
    await this.requireParticipant(sessionId, telegramUserId);
    const latest = await this.synthesisReviewRepository.findLatestProblemSynthesis(sessionId);
    if (!latest) {
      return {
        synthesis_version: null,
        review_summary: 'incomplete',
        confirm_count: 0,
        clarify_count: 0
      };
    }

    const signals = await this.synthesisReviewRepository.listReviewSignals(sessionId, latest.version);
    const confirmed = signals.filter((signal) => signal.reactionType === SynthesisReactionTypes.CONFIRM).length;
    const clarified = signals.filter((signal) => signal.reactionType === SynthesisReactionTypes.CLARIFY).length;

    let summary: ProblemSynthesisReviewSummary['review_summary'] = 'incomplete';
    if (confirmed >= 2) {
      summary = 'both_confirmed';
    } else if (clarified >= 2) {
      summary = 'both_clarified';
    } else if (confirmed >= 1 && clarified >= 1) {
      summary = 'one_confirmed_one_clarified';
    }

    return {
      synthesis_version: latest.version,
      review_summary: summary,
      confirm_count: confirmed,
      clarify_count: clarified
    };
  }

  private async buildIssueSummary(
    session: MediationSession,
    loop: IssueResolutionLoop
  ): Promise<IssueResolutionSummaryView> {
    const reactions = await this.issueResolutionRepository.listReactions(loop.caseId, loop.version);
    const metrics = loop.options.map((option) => {
      const optionReactions = reactions.filter((entry) => entry.optionId === option.option_id);
      return {
        option_id: option.option_id,
        accept_count: optionReactions.filter(
          (entry) => entry.reactionType === IssueReactionTypes.ACCEPT
        ).length,
        reject_count: optionReactions.filter(
          (entry) => entry.reactionType === IssueReactionTypes.REJECT
        ).length,
        change_request_count: optionReactions.filter(
          (entry) => entry.reactionType === IssueReactionTypes.REQUEST_CHANGE
        ).length
      };
    });

    let status: (typeof IssueLoopStatuses)[keyof typeof IssueLoopStatuses] =
      IssueLoopStatuses.IN_PROGRESS;
    let workableOptionId: string | null = null;
    for (const metric of metrics) {
      if (metric.accept_count >= 2) {
        status = IssueLoopStatuses.WORKABLE_PATH_FOUND;
        workableOptionId = metric.option_id;
        break;
      }
    }
    if (
      status === IssueLoopStatuses.IN_PROGRESS &&
      metrics.every((metric) => metric.reject_count >= 2)
    ) {
      status = IssueLoopStatuses.NO_WORKABLE_PATH;
    }

    return {
      loop_version: loop.version,
      status,
      workable_option_id: workableOptionId,
      option_reactions: metrics
    };
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
    const { session } = await this.requireParticipantRecord(sessionId, telegramUserId);
    return session;
  }

  private async requireParticipantRecord(sessionId: string, telegramUserId: string) {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = session.participants.find(
      (entry) => entry.telegramUserId === telegramUserId
    );
    if (!participant) {
      throw new TransportAccessDeniedError();
    }

    return { session, participant };
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

type ParticipantSynthesisInput = {
  facts: string;
  tension: string;
  interest: string;
  constraint: string;
  desiredOutcome: string;
  flexibility: string;
};

const requireNormalized = (value: string | null, field: string): string => {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new IntakeValidationError(`Missing confirmed intake field: ${field}.`);
  }
  return normalized;
};

const extractSynthesisThemes = (value: string): string[] => {
  const normalized = value.toLowerCase();
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

const unique = (values: string[]): string[] => [...new Set(values)];

const themesFromInput = (input: ParticipantSynthesisInput) => ({
  goals: unique(extractSynthesisThemes(`${input.desiredOutcome} ${input.flexibility}`)),
  interests: unique(extractSynthesisThemes(input.interest)),
  tension: unique(extractSynthesisThemes(`${input.tension} ${input.facts}`)),
  constraints: unique(extractSynthesisThemes(input.constraint))
});

const buildStructuredProblemSynthesis = (
  partyA: ParticipantSynthesisInput,
  partyB: ParticipantSynthesisInput
): ProblemSynthesisView => {
  const a = themesFromInput(partyA);
  const b = themesFromInput(partyB);

  const sharedGoals = a.goals.filter((theme) => b.goals.includes(theme));
  const sharedInterests = a.interests.filter((theme) => b.interests.includes(theme));
  const agreementPoints = unique([...sharedGoals, ...sharedInterests]);

  const aTensionOnly = a.tension.filter((theme) => !b.tension.includes(theme));
  const bTensionOnly = b.tension.filter((theme) => !a.tension.includes(theme));
  const tensionPoints = unique([...aTensionOnly, ...bTensionOnly]);
  const primaryTensionPoint =
    tensionPoints[0] ??
    'разные ожидания к деталям взаимодействия и способу фиксации договорённостей';

  const sharedConstraintRisk = a.constraints.filter((theme) => b.constraints.includes(theme));
  const possibleZone = unique(
    agreementPoints.length > 0
      ? [...agreementPoints]
      : [...a.goals.filter((theme) => b.interests.includes(theme)), ...b.goals.filter((theme) => a.interests.includes(theme))]
  );

  const sharedGoal =
    sharedGoals.length > 0
      ? `договориться о понятных правилах по темам: ${asHumanList(sharedGoals)}`
      : 'договориться о рабочем формате взаимодействия и ожидаемом результате';

  const zoneSummary =
    possibleZone.length > 0
      ? `начать с тем: ${asHumanList(possibleZone)} и зафиксировать общий порядок действий`
      : 'зафиксировать минимальные правила, которые учитывают ограничения обеих сторон';

  const sideAInterest =
    a.interests.length > 0
      ? `стабильность по темам: ${asHumanList(a.interests)}`
      : 'предсказуемый процесс и понятные ожидания';
  const sideBInterest =
    b.interests.length > 0
      ? `стабильность по темам: ${asHumanList(b.interests)}`
      : 'предсказуемый процесс и понятные ожидания';

  const sideAConstraint =
    a.constraints.length > 0
      ? `неподходящими выглядят варианты по темам: ${asHumanList(a.constraints)}`
      : 'нужны чёткие рамки и соблюдение договорённостей';
  const sideBConstraint =
    b.constraints.length > 0
      ? `неподходящими выглядят варианты по темам: ${asHumanList(b.constraints)}`
      : 'нужны чёткие рамки и соблюдение договорённостей';

  const tensionWithConstraints =
    sharedConstraintRisk.length > 0
      ? unique([primaryTensionPoint, ...sharedConstraintRisk])
      : unique([primaryTensionPoint, ...tensionPoints.slice(1)]);

  const finalAgreementPoints =
    agreementPoints.length > 0
      ? agreementPoints
      : ['обе стороны хотят снизить напряжение и прийти к выполнимой договорённости'];

  return {
    shared_goal: sharedGoal,
    agreement_points: finalAgreementPoints,
    tension_points: tensionWithConstraints,
    primary_tension_point: primaryTensionPoint,
    side_a_interest: sideAInterest,
    side_b_interest: sideBInterest,
    side_a_constraint: sideAConstraint,
    side_b_constraint: sideBConstraint,
    possible_zone_of_agreement: zoneSummary
  };
};

type IssueLoopInput = {
  synthesisVersion: number;
  primaryTensionPoint: string;
  sharedGoal: string;
  sideA: {
    interest: string;
    constraint: string;
    outcome: string;
    flexibility: string;
  };
  sideB: {
    interest: string;
    constraint: string;
    outcome: string;
    flexibility: string;
  };
};

type DraftAgreementInput = {
  id: string;
  caseId: string;
  version: number;
  loopVersion: number;
  sourceOption: IssueResolutionOption;
  sideA: {
    desiredOutcome: string;
    constraint: string;
    flexibility: string;
  };
  sideB: {
    desiredOutcome: string;
    constraint: string;
    flexibility: string;
  };
  mergedChangeRequest: string | null;
  createdAt: Date;
};

const buildIssueResolutionLoop = (input: IssueLoopInput) => {
  const issueThemes = unique(
    extractSynthesisThemes(
      `${input.primaryTensionPoint} ${input.sideA.outcome} ${input.sideB.outcome}`
    )
  );
  const leadTheme = issueThemes[0] ?? 'условия взаимодействия и итоговые договорённости';
  const supportTheme = issueThemes[1] ?? leadTheme;

  const issueTitle = `Согласование по теме: ${leadTheme}`;
  const sideAPriority = `Для одной стороны важно: ${input.sideA.interest}.`;
  const sideBPriority = `Для другой стороны важно: ${input.sideB.interest}.`;
  const issueConstraints = [
    `Ограничение стороны A: ${input.sideA.constraint}.`,
    `Ограничение стороны B: ${input.sideB.constraint}.`
  ];

  const option1: IssueResolutionOption = {
    option_id: 'OPTION_1',
    title: `Базовый план по теме «${leadTheme}»`,
    description: `Зафиксировать базовые правила и окно корректировок заранее, чтобы сохранить предсказуемость для обеих сторон.`,
    tradeoff_note: 'Нужно дисциплинированно подтверждать изменения заранее.'
  };
  const option2: IssueResolutionOption = {
    option_id: 'OPTION_2',
    title: `Приоритет стороны A с защитой по теме «${supportTheme}»`,
    description: `Сначала закрепить ключевой приоритет стороны A, но добавить обязательную защиту ограничений стороны B.`,
    tradeoff_note: 'Стороне B придётся принять смещение в порядке этапов.'
  };
  const option3: IssueResolutionOption = {
    option_id: 'OPTION_3',
    title: `Приоритет стороны B с защитой по теме «${supportTheme}»`,
    description: `Сначала закрепить ключевой приоритет стороны B, но добавить обязательную защиту ограничений стороны A.`,
    tradeoff_note: 'Стороне A придётся принять смещение в порядке этапов.'
  };

  return {
    issue_title: issueTitle,
    side_a_priority: sideAPriority,
    side_b_priority: sideBPriority,
    issue_constraints: issueConstraints,
    options: [option1, option2, option3],
    option_tradeoffs: [option1.tradeoff_note, option2.tradeoff_note, option3.tradeoff_note],
    synthesis_version: input.synthesisVersion,
    primary_tension_point: input.primaryTensionPoint,
    shared_goal: input.sharedGoal
  };
};

const normalizeForConvergence = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();

const resolveDraftSource = (
  loop: IssueResolutionLoop,
  reactions: Array<{
    optionId: string;
    reactionType: IssueReactionType;
    changeRequest: string | null;
  }>
): { optionId: string; mergedChangeRequest: string | null } | null => {
  const byOption = new Map<
    string,
    {
      accept: number;
      editTexts: string[];
    }
  >();

  for (const option of loop.options) {
    byOption.set(option.option_id, { accept: 0, editTexts: [] });
  }

  for (const reaction of reactions) {
    const target = byOption.get(reaction.optionId);
    if (!target) {
      continue;
    }
    if (reaction.reactionType === IssueReactionTypes.ACCEPT) {
      target.accept += 1;
    }
    if (reaction.reactionType === IssueReactionTypes.REQUEST_CHANGE && reaction.changeRequest) {
      target.editTexts.push(reaction.changeRequest);
    }
  }

  for (const [optionId, metrics] of byOption.entries()) {
    if (metrics.accept >= 2) {
      return { optionId, mergedChangeRequest: null };
    }
  }

  for (const [optionId, metrics] of byOption.entries()) {
    if (metrics.editTexts.length < 2) {
      continue;
    }
    const normalized = metrics.editTexts.map(normalizeForConvergence);
    if (normalized[0] && normalized.every((entry) => entry === normalized[0])) {
      return { optionId, mergedChangeRequest: metrics.editTexts[0] };
    }
  }

  return null;
};

const cleanAction = (value: string): string => value.replace(/\s+/g, ' ').trim();

const buildDraftAgreement = (input: DraftAgreementInput): DraftAgreement => {
  const title = `Договорённость по вопросу: ${input.sourceOption.title}`;
  const agreedActions = [
    cleanAction(
      `Стороны используют вариант «${input.sourceOption.title}» как базовый порядок действий.`
    ),
    cleanAction(
      `Сторона A получает: ${input.sideA.desiredOutcome}. Сторона B получает: ${input.sideB.desiredOutcome}.`
    ),
    cleanAction(
      `Все изменения согласуются заранее в чате и применяются только после подтверждения обеих сторон.`
    )
  ];

  if (input.mergedChangeRequest) {
    agreedActions.push(cleanAction(`Дополнение по запросу сторон: ${input.mergedChangeRequest}.`));
  }

  const boundaries = [
    cleanAction(`Не допускается: ${input.sideA.constraint}.`),
    cleanAction(`Не допускается: ${input.sideB.constraint}.`)
  ];
  const conditions = [
    cleanAction(`Применяется к текущему спорному вопросу по теме «${input.sourceOption.title}».`),
    cleanAction(
      `Гибкость сторон: A — ${input.sideA.flexibility}; B — ${input.sideB.flexibility}.`
    )
  ];

  return {
    id: input.id,
    caseId: input.caseId,
    version: input.version,
    loopVersion: input.loopVersion,
    sourceOptionId: input.sourceOption.option_id,
    agreementTitle: title,
    agreedActions,
    boundaries,
    conditions,
    fallbackRule:
      'Если договорённость не выполняется два раза подряд, стороны возвращаются к вариантам и выбирают новый.',
    reviewPoint: 'Пересмотр через 7 дней или раньше по совместному запросу.',
    createdAt: input.createdAt
  };
};

const mapDraftAgreement = (draft: DraftAgreement): DraftAgreementView => ({
  draft_version: draft.version,
  loop_version: draft.loopVersion,
  source_option_id: draft.sourceOptionId,
  agreement_title: draft.agreementTitle,
  agreed_actions: draft.agreedActions,
  boundaries: draft.boundaries,
  conditions: draft.conditions,
  fallback_rule: draft.fallbackRule,
  review_point: draft.reviewPoint
});
