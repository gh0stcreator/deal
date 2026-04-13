import { Context } from 'grammy';
import { TelegramEventType } from './constants.js';
import { makeCorrelationId, userIdFromCtx } from './helpers.js';
import { BotDeps } from './botDeps.js';

export const detectCurrentUxStep = (telegramUserId: string, deps: BotDeps): string => {
  if (deps.pendingSynthesisClarificationSession.has(telegramUserId)) {
    return 'SYNTHESIS_CLARIFICATION_INPUT';
  }
  if (deps.pendingIssueChange.has(telegramUserId)) {
    return 'ISSUE_OPTION_EDIT_INPUT';
  }
  if (deps.pendingDraftAgreementChange.has(telegramUserId)) {
    return 'DRAFT_AGREEMENT_EDIT_INPUT';
  }
  if (deps.pendingMediationIntakeDraft.has(telegramUserId)) {
    return 'INTAKE_CONFIRMATION_PENDING';
  }
  if (deps.pendingMediationIntakeSession.has(telegramUserId)) {
    return 'INTAKE_QUESTION_PENDING';
  }
  if (deps.pendingCreateTopicDraft.has(telegramUserId)) {
    return 'CREATE_TOPIC_CONFIRMATION_PENDING';
  }
  const pending = deps.pendingInput.get(telegramUserId);
  if (pending === 'CREATE_TOPIC') {
    return 'CREATE_TOPIC_INPUT_PENDING';
  }
  if (pending === 'JOIN_TOKEN') {
    return 'JOIN_TOKEN_INPUT_PENDING';
  }
  if (deps.lastSessionByUser.has(telegramUserId)) {
    return 'SESSION_ACTIVE';
  }
  return 'IDLE';
};

export const extractSessionIdFromCallbackData = (data: string | undefined): string | null => {
  if (!data) {
    return null;
  }
  const patterns = [
    /^consent:([A-Za-z0-9_-]{3,})$/,
    /^status:([A-Za-z0-9_-]{3,})$/,
    /^intake:(?:edit|confirm):([A-Za-z0-9_-]{3,}):[a-z_]+$/,
    /^synthesis:(?:ok|clarify):([A-Za-z0-9_-]{3,})$/,
    /^issue:react:([A-Za-z0-9_-]{3,}):\d+:[A-Z0-9_]+:(?:accept|reject|edit)$/,
    /^agreement:respond:([A-Za-z0-9_-]{3,}):\d+:(?:confirm|edit|reject)$/
  ];
  for (const pattern of patterns) {
    const match = data.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
};

export const detectEventType = (ctx: Context): TelegramEventType => {
  if (ctx.callbackQuery) {
    return 'callback';
  }
  const text = ctx.message?.text;
  if (!text) {
    return 'other';
  }
  if (text.startsWith('/')) {
    return 'command';
  }
  return 'message';
};

export const detectCommandName = (ctx: Context): string | null => {
  const text = ctx.message?.text?.trim();
  if (!text || !text.startsWith('/')) {
    return null;
  }
  return text.split(/\s+/)[0] ?? null;
};

export const resolveSessionContext = async (ctx: Context, telegramUserId: string, deps: BotDeps) => {
  const callbackSessionId = extractSessionIdFromCallbackData(ctx.callbackQuery?.data);
  const sessionId = callbackSessionId ?? deps.pendingMediationIntakeSession.get(telegramUserId) ?? deps.lastSessionByUser.get(telegramUserId) ?? null;
  if (!sessionId) {
    return {
      session_id: null as string | null,
      protocol_state: null as string | null,
      role: null as string | null
    };
  }
  try {
    const session = await deps.gateway.getSessionStatus(sessionId, telegramUserId);
    const self = session.participants.find((entry) => entry.telegramUserId === telegramUserId);
    return {
      session_id: sessionId,
      protocol_state: session.state,
      role: self?.role ?? null
    };
  } catch {
    return {
      session_id: sessionId,
      protocol_state: null,
      role: null
    };
  }
};

export const logInboundEvent = async (ctx: Context, handler: string, deps: BotDeps): Promise<void> => {
  const telegramUserId = userIdFromCtx(ctx);
  const context = await resolveSessionContext(ctx, telegramUserId, deps);
  deps.logger.info(
    {
      correlation_id: makeCorrelationId(ctx),
      handler,
      event_type: detectEventType(ctx),
      command: detectCommandName(ctx),
      callback_data: ctx.callbackQuery?.data ?? null,
      telegram_user_id: telegramUserId,
      session_id: context.session_id,
      role: context.role,
      current_ux_step: detectCurrentUxStep(telegramUserId, deps),
      current_protocol_state: context.protocol_state
    },
    'telegram.ux.event.received'
  );
};

export const logTransition = async (
  ctx: Context,
  handler: string,
  result: 'success' | 'error',
  errorCode: string | null | undefined,
  deps: BotDeps
): Promise<void> => {
  const telegramUserId = userIdFromCtx(ctx);
  const context = await resolveSessionContext(ctx, telegramUserId, deps);
  deps.logger.info(
    {
      correlation_id: makeCorrelationId(ctx),
      handler,
      result,
      error_code: errorCode ?? null,
      telegram_user_id: telegramUserId,
      session_id: context.session_id,
      role: context.role,
      next_ux_step: detectCurrentUxStep(telegramUserId, deps),
      next_protocol_state: context.protocol_state
    },
    'telegram.ux.event.transition'
  );
};
