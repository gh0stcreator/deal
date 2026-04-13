import { Bot } from 'grammy';
import { AppLogger } from '../../application/ports/AppLogger.js';
import { ConversationStateRepository } from '../../application/ports/ConversationStateRepository.js';
import { ProtocolGatewayService } from '../../application/services/ProtocolGatewayService.js';
import { IntakeDialogManager, ConversationTurn } from '../../application/ports/IntakeDialogManager.js';
import { InMemoryRateLimiter } from '../transport/rateLimiter.js';
import { PendingInputKind, MediationIntakeStepId } from './constants.js';

export interface BotDeps {
  bot: Bot;
  gateway: ProtocolGatewayService;
  conversationStateRepository: ConversationStateRepository;
  dialogManager: IntakeDialogManager;
  logger: AppLogger;
  rateLimiter: InMemoryRateLimiter;
  maxSendAttempts: number;
  baseBackoffMs: number;
  maxTelegramMessageLength: number;
  sleep: (ms: number) => Promise<void>;

  // Shared Maps
  intakeConversationHistory: Map<string, ConversationTurn[]>;
  pendingInput: Map<string, PendingInputKind>;
  pendingCreateTopicDraft: Map<string, { topic: string }>;
  pendingMediationIntakeSession: Map<string, string>;
  pendingMediationIntakeStep: Map<string, MediationIntakeStepId>;
  pendingMediationIntakeDraft: Map<string, { sessionId: string; stepId: MediationIntakeStepId; text: string; reflection: string }>;
  pendingSynthesisClarificationSession: Map<string, string>;
  problemSynthesisSent: Set<string>;
  issueLoopSent: Set<string>;
  draftAgreementSent: Set<string>;
  pendingIssueChange: Map<string, { sessionId: string; loopVersion: number; optionId: string }>;
  pendingDraftAgreementChange: Map<string, { sessionId: string; draftVersion: number }>;
  eventErrorCodeByCorrelation: Map<string, string | null>;
  lastSessionByUser: Map<string, string>;
  lastInviteByUser: Map<string, { deepLink: string | null; token: string; topic: string; initiatorName: string }>;
}
