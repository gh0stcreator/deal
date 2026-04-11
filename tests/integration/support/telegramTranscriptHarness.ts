import { Bot } from 'grammy';
import { AppLogger } from '../../../src/application/ports/AppLogger.js';
import { Clock } from '../../../src/application/ports/Clock.js';
import { DeterministicIntakeNormalizer } from '../../../src/application/ports/IntakeNormalizer.js';
import { IdGenerator } from '../../../src/application/ports/IdGenerator.js';
import { IntakeService } from '../../../src/application/services/IntakeService.js';
import { MediationService } from '../../../src/application/services/MediationService.js';
import { NegotiationService } from '../../../src/application/services/NegotiationService.js';
import { DeterministicProposalMapper } from '../../../src/application/services/DeterministicProposalMapper.js';
import { ProposalGenerationService } from '../../../src/application/services/ProposalGenerationService.js';
import { DeterministicSynthesisMapper } from '../../../src/application/services/DeterministicSynthesisMapper.js';
import { ProtocolGatewayService } from '../../../src/application/services/ProtocolGatewayService.js';
import { SynthesisService } from '../../../src/application/services/SynthesisService.js';
import { InMemoryDraftAgreementRepository } from '../../../src/infrastructure/repositories/InMemoryDraftAgreementRepository.js';
import { InMemoryIntakeRepository } from '../../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryIssueResolutionRepository } from '../../../src/infrastructure/repositories/InMemoryIssueResolutionRepository.js';
import { InMemoryMediationSummaryRepository } from '../../../src/infrastructure/repositories/InMemoryMediationSummaryRepository.js';
import { InMemoryNegotiationRoundRepository } from '../../../src/infrastructure/repositories/InMemoryNegotiationRoundRepository.js';
import { InMemoryProposalSetRepository } from '../../../src/infrastructure/repositories/InMemoryProposalSetRepository.js';
import { InMemoryProtocolTrackingRepository } from '../../../src/infrastructure/repositories/InMemoryProtocolTrackingRepository.js';
import { InMemorySessionEvaluationRepository } from '../../../src/infrastructure/repositories/InMemorySessionEvaluationRepository.js';
import { InMemorySessionRepository } from '../../../src/infrastructure/repositories/InMemorySessionRepository.js';
import { InMemorySynthesisReviewRepository } from '../../../src/infrastructure/repositories/InMemorySynthesisReviewRepository.js';
import { buildTelegramBot } from '../../../src/infrastructure/telegram/bot.js';
import { InMemoryRateLimiter } from '../../../src/infrastructure/transport/rateLimiter.js';

class MutableClock implements Clock {
  constructor(private value: Date) {}

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

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  bindings: Record<string, unknown>;
}

class CaptureLogger implements AppLogger {
  readonly entries: LogEntry[] = [];

  debug(bindings: Record<string, unknown>, message?: string): void {
    this.entries.push({ level: 'debug', bindings, message });
  }

  info(bindings: Record<string, unknown>, message?: string): void {
    this.entries.push({ level: 'info', bindings, message });
  }

  warn(bindings: Record<string, unknown>, message?: string): void {
    this.entries.push({ level: 'warn', bindings, message });
  }

  error(bindings: Record<string, unknown>, message?: string): void {
    this.entries.push({ level: 'error', bindings, message });
  }
}

export type TranscriptStep =
  | { type: 'command'; updateId: number; userId: number; text: string }
  | { type: 'text'; updateId: number; userId: number; text: string }
  | { type: 'callback'; updateId: number; userId: number; data: string };

export interface StepExpectations {
  textIncludes?: string[];
  buttonsInclude?: string[];
  uxStep?: string;
  protocolState?: string | null;
}

export interface TelegramTranscriptHarness {
  bot: Bot;
  gateway: ProtocolGatewayService;
  logger: CaptureLogger;
  sentMessages: Array<{ chatId: number; text: string; replyMarkupJson: string }>;
  runStep: (step: TranscriptStep, expected?: StepExpectations) => Promise<void>;
  replayTranscript: (steps: TranscriptStep[]) => Promise<void>;
  extractLastInviteToken: () => string;
}

const findLast = <T>(items: T[], predicate: (item: T) => boolean): T | undefined => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) {
      return items[i];
    }
  }
  return undefined;
};

const sendCommand = async (bot: Bot, updateId: number, userId: number, text: string) => {
  const command = text.split(/\s+/)[0] ?? '/';
  await bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text,
      entities: [
        {
          offset: 0,
          length: command.length,
          type: 'bot_command'
        }
      ],
      from: { id: userId, is_bot: false, first_name: 'user' },
      chat: { id: userId, type: 'private' }
    }
  } as never);
};

const sendText = async (bot: Bot, updateId: number, userId: number, text: string) => {
  await bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text,
      from: { id: userId, is_bot: false, first_name: 'user' },
      chat: { id: userId, type: 'private' }
    }
  } as never);
};

const sendCallback = async (bot: Bot, updateId: number, userId: number, data: string) => {
  await bot.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId, is_bot: false, first_name: 'user' },
      chat_instance: `chat-${userId}`,
      data,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: userId, type: 'private' }
      }
    }
  } as never);
};

export const createTelegramTranscriptHarness = async (): Promise<TelegramTranscriptHarness> => {
  const clock = new MutableClock(new Date('2026-04-11T10:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const logger = new CaptureLogger();

  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();
  const proposalSetRepo = new InMemoryProposalSetRepository();
  const roundRepo = new InMemoryNegotiationRoundRepository();
  const trackingRepo = new InMemoryProtocolTrackingRepository();
  const synthesisReviewRepo = new InMemorySynthesisReviewRepository();
  const issueRepo = new InMemoryIssueResolutionRepository();
  const draftRepo = new InMemoryDraftAgreementRepository();
  const sessionEvaluationRepo = new InMemorySessionEvaluationRepository();

  const mediationService = new MediationService(sessionRepo, clock, ids);
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
    roundRepo,
    ids,
    clock
  );

  const gateway = new ProtocolGatewayService(
    mediationService,
    intakeService,
    synthesisService,
    proposalService,
    negotiationService,
    sessionRepo,
    proposalSetRepo,
    trackingRepo,
    ids,
    clock,
    logger,
    synthesisReviewRepo,
    issueRepo,
    draftRepo,
    sessionEvaluationRepo
  );

  const bot = buildTelegramBot('test-token', gateway, {
    logger,
    rate_limiter: new InMemoryRateLimiter(clock),
    max_send_attempts: 3,
    base_backoff_ms: 1,
    sleep: async () => undefined
  });
  (bot as Bot).botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'Ladno',
    username: 'ladno_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false
  };

  const sentMessages: Array<{ chatId: number; text: string; replyMarkupJson: string }> = [];
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      sentMessages.push({
        chatId: Number((payload as { chat_id: number }).chat_id),
        text: (payload as { text?: string }).text ?? '',
        replyMarkupJson: JSON.stringify((payload as { reply_markup?: unknown }).reply_markup ?? {})
      });
      return {
        ok: true,
        result: {
          message_id: sentMessages.length,
          date: 0,
          chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
          text: (payload as { text?: string }).text ?? ''
        }
      } as never;
    }

    return prev(method, payload, signal);
  });

  const runStep = async (step: TranscriptStep, expected?: StepExpectations) => {
    const beforeCount = sentMessages.length;
    if (step.type === 'command') {
      await sendCommand(bot, step.updateId, step.userId, step.text);
    } else if (step.type === 'text') {
      await sendText(bot, step.updateId, step.userId, step.text);
    } else {
      await sendCallback(bot, step.updateId, step.userId, step.data);
    }

    if (!expected) {
      return;
    }

    const newForUser = sentMessages.slice(beforeCount).filter((entry) => entry.chatId === step.userId);
    const lastForUser = newForUser.at(-1) ?? findLast(sentMessages, (entry) => entry.chatId === step.userId);
    if (!lastForUser) {
      throw new Error(`No bot message for user ${step.userId} after update ${step.updateId}`);
    }
    const mergedTexts = newForUser.length > 0 ? newForUser.map((entry) => entry.text).join('\n') : lastForUser.text;

    for (const chunk of expected.textIncludes ?? []) {
      if (!mergedTexts.includes(chunk)) {
        throw new Error(
          `Expected text to include "${chunk}" after update ${step.updateId}. Actual: ${mergedTexts}`
        );
      }
    }
    for (const button of expected.buttonsInclude ?? []) {
      if (!lastForUser.replyMarkupJson.includes(button)) {
        throw new Error(
          `Expected buttons to include "${button}" after update ${step.updateId}. Actual: ${lastForUser.replyMarkupJson}`
        );
      }
    }

    const correlationId = `tg:${step.updateId}:${step.userId}`;
    const transition = findLast(
      logger.entries,
      (entry) =>
        entry.message === 'telegram.ux.event.transition' &&
        entry.bindings.correlation_id === correlationId
    );
    if (!transition) {
      throw new Error(`No transition log for correlation ${correlationId}`);
    }
    if (expected.uxStep && transition.bindings.next_ux_step !== expected.uxStep) {
      throw new Error(
        `Expected ux step "${expected.uxStep}" but got "${String(transition.bindings.next_ux_step)}"`
      );
    }
    if (expected.protocolState !== undefined && transition.bindings.next_protocol_state !== expected.protocolState) {
      throw new Error(
        `Expected protocol state "${String(expected.protocolState)}" but got "${String(
          transition.bindings.next_protocol_state
        )}"`
      );
    }
  };

  const replayTranscript = async (steps: TranscriptStep[]) => {
    for (const step of steps) {
      await runStep(step);
    }
  };

  const extractLastInviteToken = () => {
    const invite = findLast(sentMessages, (entry) => entry.text.includes('join_'));
    if (!invite) {
      throw new Error('Invite link message not found');
    }
    const match = invite.text.match(/join_([A-Za-z0-9_-]+)/);
    if (!match) {
      throw new Error(`Invite token not found in message: ${invite.text}`);
    }
    return match[1];
  };

  return {
    bot,
    gateway,
    logger,
    sentMessages,
    runStep,
    replayTranscript,
    extractLastInviteToken
  };
};
