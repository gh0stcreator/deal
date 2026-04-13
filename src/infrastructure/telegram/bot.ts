import { Bot } from 'grammy';
import { SystemClock } from '../../application/ports/Clock.js';
import { AppLogger, createNoopLogger } from '../../application/ports/AppLogger.js';
import { ConversationStateRepository } from '../../application/ports/ConversationStateRepository.js';
import { ProtocolGatewayService } from '../../application/services/ProtocolGatewayService.js';
import { IntakeDialogManager, ConversationTurn } from '../../application/ports/IntakeDialogManager.js';
import { InMemoryRateLimiter } from '../transport/rateLimiter.js';
import { InMemoryConversationStateRepository } from '../repositories/InMemoryConversationStateRepository.js';
import { DeterministicIntakeDialogManager } from '../llm/DeterministicIntakeDialogManager.js';
import { makeCorrelationId, userIdFromCtx } from './helpers.js';
import { PendingInputKind, MediationIntakeStepId } from './constants.js';
import { BotDeps } from './botDeps.js';
import { logInboundEvent, logTransition } from './logging.js';
import { registerCommandHandlers } from './handlers/commandHandlers.js';
import { registerMenuCallbacks } from './handlers/menuCallbacks.js';
import { registerSessionCallbacks } from './handlers/sessionCallbacks.js';
import { registerIntakeCallbacks } from './handlers/intakeCallbacks.js';
import { registerSynthesisCallbacks } from './handlers/synthesisCallbacks.js';
import { registerInviteCallbacks } from './handlers/inviteCallbacks.js';
import { registerIssueCallbacks } from './handlers/issueCallbacks.js';
import { registerAgreementCallbacks } from './handlers/agreementCallbacks.js';
import { registerTextHandler } from './handlers/textHandler.js';

export interface TelegramBotOptions {
  logger?: AppLogger;
  rate_limiter?: InMemoryRateLimiter;
  max_send_attempts?: number;
  base_backoff_ms?: number;
  sleep?: (ms: number) => Promise<void>;
  render_safe_mode?: boolean;
  conversation_state_repository?: ConversationStateRepository;
  intake_dialog_manager?: IntakeDialogManager;
}

export const buildTelegramBot = (
  token: string,
  gateway: ProtocolGatewayService,
  options: TelegramBotOptions = {}
) => {
  const logger = options.logger ?? createNoopLogger();
  const rateLimiter = options.rate_limiter ?? new InMemoryRateLimiter(new SystemClock());
  const maxSendAttempts = options.max_send_attempts ?? 3;
  const baseBackoffMs = options.base_backoff_ms ?? 150;
  const renderSafeMode = options.render_safe_mode ?? false;
  const maxTelegramMessageLength = renderSafeMode ? 3500 : 3900;
  const conversationStateRepository =
    options.conversation_state_repository ?? new InMemoryConversationStateRepository();
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dialogManager = options.intake_dialog_manager ?? new DeterministicIntakeDialogManager();

  const intakeConversationHistory = new Map<string, ConversationTurn[]>();
  const pendingInput = new Map<string, PendingInputKind>();
  const pendingCreateTopicDraft = new Map<string, { topic: string }>();
  const pendingMediationIntakeSession = new Map<string, string>();
  const pendingMediationIntakeStep = new Map<string, MediationIntakeStepId>();
  const pendingMediationIntakeDraft = new Map<
    string,
    { sessionId: string; stepId: MediationIntakeStepId; text: string; reflection: string }
  >();
  const pendingSynthesisClarificationSession = new Map<string, string>();
  const problemSynthesisSent = new Set<string>();
  const issueLoopSent = new Set<string>();
  const draftAgreementSent = new Set<string>();
  const pendingIssueChange = new Map<
    string,
    { sessionId: string; loopVersion: number; optionId: string }
  >();
  const pendingDraftAgreementChange = new Map<
    string,
    { sessionId: string; draftVersion: number }
  >();
  const eventErrorCodeByCorrelation = new Map<string, string | null>();
  const lastSessionByUser = new Map<string, string>();
  const lastInviteByUser = new Map<
    string,
    { deepLink: string | null; token: string; topic: string; initiatorName: string }
  >();

  const bot = new Bot(token);

  const deps: BotDeps = {
    bot,
    gateway,
    conversationStateRepository,
    dialogManager,
    logger,
    rateLimiter,
    maxSendAttempts,
    baseBackoffMs,
    maxTelegramMessageLength,
    sleep,
    intakeConversationHistory,
    pendingInput,
    pendingCreateTopicDraft,
    pendingMediationIntakeSession,
    pendingMediationIntakeStep,
    pendingMediationIntakeDraft,
    pendingSynthesisClarificationSession,
    problemSynthesisSent,
    issueLoopSent,
    draftAgreementSent,
    pendingIssueChange,
    pendingDraftAgreementChange,
    eventErrorCodeByCorrelation,
    lastSessionByUser,
    lastInviteByUser
  };

  bot.use(async (ctx, next) => {
    const correlationId = makeCorrelationId(ctx);
    await logInboundEvent(ctx, 'middleware', deps);
    await next();
    const errorCode = eventErrorCodeByCorrelation.get(correlationId) ?? null;
    eventErrorCodeByCorrelation.delete(correlationId);
    await logTransition(ctx, 'middleware', errorCode ? 'error' : 'success', errorCode, deps);
  });

  registerCommandHandlers(bot, deps);
  registerMenuCallbacks(bot, deps);
  registerSessionCallbacks(bot, deps);
  registerIntakeCallbacks(bot, deps);
  registerSynthesisCallbacks(bot, deps);
  registerInviteCallbacks(bot, deps);
  registerIssueCallbacks(bot, deps);
  registerAgreementCallbacks(bot, deps);
  registerTextHandler(bot, deps);

  bot.catch(async (err) => {
    const ctx = err.ctx;
    logger.error(
      {
        error: err.error instanceof Error ? err.error.message : String(err.error),
        update_id: ctx.update.update_id,
        telegram_user_id: userIdFromCtx(ctx)
      },
      'telegram.unhandled.error'
    );
    try {
      await ctx.reply('Что-то пошло не так. Нажмите /start, чтобы продолжить.');
    } catch {
      // ignore send failure
    }
  });

  return bot;
};
