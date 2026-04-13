import { Context, InlineKeyboard } from 'grammy';
import { DomainError } from '../../domain/session/errors.js';
import { mapTelegramErrorText } from '../transport/errorMapping.js';
import { isTransientTelegramSendError, makeCorrelationId, userIdFromCtx } from './helpers.js';
import { RATE_LIMIT_WINDOW_MS } from './constants.js';
import { BotDeps } from './botDeps.js';

export const sanitizeTelegramText = (value: string): string => {
  const normalized = value
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\uFFFD+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || ' ';
};

export const splitTelegramText = (text: string, maxTelegramMessageLength: number): string[] => {
  if (text.length <= maxTelegramMessageLength) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxTelegramMessageLength) {
    const candidate = rest.slice(0, maxTelegramMessageLength);
    const splitAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    const index = splitAt > maxTelegramMessageLength * 0.6 ? splitAt : maxTelegramMessageLength;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trimStart();
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks.length > 0 ? chunks : [' '];
};

export const prepareOutboundPayload = (text: string, maxTelegramMessageLength: number) => {
  const rawText = text ?? '';
  const sanitized = sanitizeTelegramText(rawText);
  const chunks = splitTelegramText(sanitized, maxTelegramMessageLength);
  return { rawText, chunks };
};

export const sendReplyWithRetry = async (
  ctx: Context,
  text: string,
  metadata: { correlation_id: string; action_type: string },
  extra: { reply_markup?: InlineKeyboard } | undefined,
  deps: BotDeps
): Promise<boolean> => {
  const payload = prepareOutboundPayload(text, deps.maxTelegramMessageLength);
  for (let index = 0; index < payload.chunks.length; index += 1) {
    const chunk = payload.chunks[index];
    const isLastChunk = index === payload.chunks.length - 1;
    const chunkExtra = isLastChunk ? extra : undefined;
    deps.logger.info(
      {
        correlation_id: metadata.correlation_id,
        action_type: metadata.action_type,
        chunk_index: index + 1,
        chunk_count: payload.chunks.length,
        raw_text: payload.rawText,
        text: chunk,
        length: chunk.length,
        parse_mode: null,
        buttons_attached: Boolean(chunkExtra?.reply_markup),
        buttons_payload: chunkExtra?.reply_markup ? JSON.stringify(chunkExtra.reply_markup) : null
      },
      'telegram.outbound.payload'
    );

    let delivered = false;
    for (let attempt = 1; attempt <= deps.maxSendAttempts; attempt += 1) {
      try {
        await ctx.reply(chunk, chunkExtra);
        deps.logger.info(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt,
            chunk_index: index + 1
          },
          'telegram.outbound.send.success'
        );
        delivered = true;
        break;
      } catch (error) {
        const isTransient = isTransientTelegramSendError(error);
        deps.logger.warn(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt,
            chunk_index: index + 1,
            transient: isTransient,
            error: error instanceof Error ? error.message : 'unknown'
          },
          'telegram.outbound.send.failed'
        );

        if (!isTransient || attempt >= deps.maxSendAttempts) {
          deps.logger.error(
            {
              correlation_id: metadata.correlation_id,
              action_type: metadata.action_type,
              chunk_index: index + 1
            },
            'telegram.outbound.send.give_up'
          );
          return false;
        }
        await deps.sleep(deps.baseBackoffMs * 2 ** (attempt - 1));
      }
    }

    if (!delivered) {
      return false;
    }
  }

  return true;
};

export const sendDirectWithRetry = async (
  chatId: string,
  text: string,
  metadata: { correlation_id: string; action_type: string },
  extra: { reply_markup?: InlineKeyboard } | undefined,
  deps: BotDeps
): Promise<boolean> => {
  const payload = prepareOutboundPayload(text, deps.maxTelegramMessageLength);
  for (let index = 0; index < payload.chunks.length; index += 1) {
    const chunk = payload.chunks[index];
    const isLastChunk = index === payload.chunks.length - 1;
    const chunkExtra = isLastChunk ? extra : undefined;
    deps.logger.info(
      {
        correlation_id: metadata.correlation_id,
        action_type: metadata.action_type,
        chat_id: chatId,
        chunk_index: index + 1,
        chunk_count: payload.chunks.length,
        raw_text: payload.rawText,
        text: chunk,
        length: chunk.length,
        parse_mode: null,
        buttons_attached: Boolean(chunkExtra?.reply_markup),
        buttons_payload: chunkExtra?.reply_markup ? JSON.stringify(chunkExtra.reply_markup) : null
      },
      'telegram.outbound.payload'
    );

    let delivered = false;
    for (let attempt = 1; attempt <= deps.maxSendAttempts; attempt += 1) {
      try {
        await deps.bot.api.sendMessage(Number(chatId), chunk, chunkExtra);
        deps.logger.info(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt,
            chunk_index: index + 1
          },
          'telegram.outbound.send.success'
        );
        delivered = true;
        break;
      } catch (error) {
        const isTransient = isTransientTelegramSendError(error);
        deps.logger.warn(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt,
            chunk_index: index + 1,
            transient: isTransient,
            error: error instanceof Error ? error.message : 'unknown'
          },
          'telegram.outbound.send.failed'
        );

        if (!isTransient || attempt >= deps.maxSendAttempts) {
          return false;
        }
        await deps.sleep(deps.baseBackoffMs * 2 ** (attempt - 1));
      }
    }

    if (!delivered) {
      return false;
    }
  }
  return true;
};

export const enforceRateLimit = async (
  ctx: Context,
  config: { key: string; limit: number; action_type: string },
  deps: BotDeps
): Promise<boolean> => {
  const decision = deps.rateLimiter.consume(config.key, config.limit, RATE_LIMIT_WINDOW_MS);
  if (decision.allowed) {
    return true;
  }

  await sendReplyWithRetry(
    ctx,
    'Слишком много запросов. Попробуйте через несколько секунд.',
    {
      correlation_id: makeCorrelationId(ctx),
      action_type: config.action_type
    },
    undefined,
    deps
  );

  deps.logger.warn(
    {
      correlation_id: makeCorrelationId(ctx),
      action_type: config.action_type,
      retry_after_seconds: decision.retry_after_seconds,
      participant_id: userIdFromCtx(ctx)
    },
    'telegram.action.rate_limited'
  );

  return false;
};

export const safeAnswerCallback = async (ctx: Context): Promise<void> => {
  if (!ctx.callbackQuery) {
    return;
  }
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // no-op
  }
};

export const replyWithMappedError = async (
  ctx: Context,
  error: unknown,
  actionType: string,
  handler: string,
  deps: BotDeps
): Promise<void> => {
  const domainCode = error instanceof DomainError ? error.code : null;
  deps.eventErrorCodeByCorrelation.set(makeCorrelationId(ctx), domainCode);
  deps.logger.warn(
    {
      correlation_id: makeCorrelationId(ctx),
      handler,
      action_type: actionType,
      error_code: domainCode,
      error_message: error instanceof Error ? error.message : String(error)
    },
    'telegram.handler.error'
  );
  await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
    correlation_id: makeCorrelationId(ctx),
    action_type: actionType
  }, undefined, deps);
  // logTransition will be called by the caller after this
};

export const requireArgCount = async (
  ctx: Context,
  args: string[],
  count: number,
  usage: string,
  actionType: string,
  deps: BotDeps
): Promise<boolean> => {
  if (args.length < count) {
    await sendReplyWithRetry(
      ctx,
      usage,
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: actionType
      },
      undefined,
      deps
    );
    return false;
  }

  return true;
};
