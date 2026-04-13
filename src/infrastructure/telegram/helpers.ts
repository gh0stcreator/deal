import { createHash } from 'node:crypto';
import { Context } from 'grammy';
import { MediationIntakeStepId } from './constants.js';
import { ProposalVariantTypes } from '../../domain/proposal/types.js';
import { SuggestEditOperations } from '../../domain/negotiation/types.js';

export const parseArgs = (text: string | undefined): string[] => {
  if (!text) {
    return [];
  }

  const parts = text.trim().split(/\s+/g);
  return parts.slice(1);
};

export const userIdFromCtx = (ctx: Context): string => String(ctx.from?.id ?? 'unknown');

export const makeCorrelationId = (ctx: Context): string =>
  `tg:${ctx.update.update_id}:${userIdFromCtx(ctx)}`;

export const makeKey = (ctx: Context, actionType: string): string =>
  `tg:${ctx.update.update_id}:${userIdFromCtx(ctx)}:${actionType}`;

export const makeStableIntakeConfirmKey = (
  sessionId: string,
  telegramUserId: string,
  stepId: MediationIntakeStepId,
  text: string
): string => {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `tg:intake_confirm:${sessionId}:${telegramUserId}:${stepId}:${digest}`;
};

export const variantValues = Object.values(ProposalVariantTypes);
export const operationValues = Object.values(SuggestEditOperations);

export const extractInviteToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const fromStartPayload = trimmed.match(/\/start\s+join_([A-Za-z0-9_-]+)/i);
  if (fromStartPayload) {
    return fromStartPayload[1];
  }

  const fromDeepLink = trimmed.match(/[?&]start=join_([A-Za-z0-9_-]+)/i);
  if (fromDeepLink) {
    return fromDeepLink[1];
  }

  const plainJoinPayload = trimmed.match(/^join_([A-Za-z0-9_-]+)$/i);
  if (plainJoinPayload) {
    return plainJoinPayload[1];
  }

  const plainToken = trimmed.match(/^[A-Za-z0-9_-]{12,}$/);
  if (plainToken) {
    return plainToken[0];
  }

  const tokenFromText = trimmed.match(/([A-Za-z0-9_-]{12,})/);
  if (tokenFromText) {
    return tokenFromText[1];
  }

  return null;
};

export const normalizeProblemTopicInput = (value: string): string | null => {
  const plain = value.replace(/\s+/g, ' ').trim();
  if (!plain || plain.length > 120) {
    return null;
  }
  return plain;
};

export const isTransientTelegramSendError = (error: unknown): boolean => {
  const maybeError = error as { error_code?: number; description?: string } | undefined;
  if (!maybeError) {
    return true;
  }

  if (typeof maybeError.error_code === 'number') {
    if (maybeError.error_code >= 500 || maybeError.error_code === 429) {
      return true;
    }

    return false;
  }

  const description = maybeError.description?.toLowerCase() ?? '';
  return (
    description.includes('timeout') ||
    description.includes('temporarily') ||
    description.includes('network')
  );
};
