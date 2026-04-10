import { Bot, Context } from 'grammy';
import { ProtocolGatewayService } from '../../application/services/ProtocolGatewayService.js';
import { SuggestEditOperations } from '../../domain/negotiation/types.js';
import { ProposalVariantTypes } from '../../domain/proposal/types.js';
import { mapTelegramErrorText } from '../transport/errorMapping.js';
import {
  mapIntakeStatusView,
  mapNegotiationRoundStatusView,
  mapProposalListView,
  mapSessionStatusView
} from '../transport/viewMappers.js';

const parseArgs = (text: string | undefined): string[] => {
  if (!text) {
    return [];
  }

  const parts = text.trim().split(/\s+/g);
  return parts.slice(1);
};

const userIdFromCtx = (ctx: Context): string => String(ctx.from?.id ?? 'unknown');

const requireArgCount = async (ctx: Context, args: string[], count: number, usage: string) => {
  if (args.length < count) {
    await ctx.reply(usage);
    return false;
  }

  return true;
};

const makeKey = (ctx: Context, actionType: string): string =>
  `tg:${ctx.update.update_id}:${userIdFromCtx(ctx)}:${actionType}`;

const variantValues = Object.values(ProposalVariantTypes);
const operationValues = Object.values(SuggestEditOperations);

const renderSession = (session: ReturnType<typeof mapSessionStatusView>) =>
  [
    `session: ${session.session_id}`,
    `state: ${session.state}`,
    `participants: ${session.participant_count}/2`,
    `consents: ${session.consent_count}/2`
  ].join('\n');

const renderIntake = (view: ReturnType<typeof mapIntakeStatusView>) =>
  [
    `intake: ${view.intake_id}`,
    `state: ${view.state}`,
    `current_field: ${view.current_field ?? 'none'}`,
    `summary_ready: ${view.has_generated_summary ? 'yes' : 'no'}`,
    `confirmed: ${view.has_confirmed_summary ? 'yes' : 'no'}`,
    `version: ${view.version}`
  ].join('\n');

const renderProposalList = (view: ReturnType<typeof mapProposalListView>) =>
  [
    `case: ${view.case_id}`,
    `proposal_set_version: ${view.proposal_set_version}`,
    ...view.variants.map(
      (variant) => `- ${variant.variant_type}: ${variant.title} | ${variant.summary}`
    )
  ].join('\n');

const renderNegotiation = (view: ReturnType<typeof mapNegotiationRoundStatusView>) =>
  [
    `session: ${view.session_id}`,
    `state: ${view.session_state}`,
    `round: ${view.current_round_number ?? 'pending'}`,
    `proposal_set_version: ${view.proposal_set_version}`,
    `round_status: ${view.round_status ?? 'none'}`
  ].join('\n');

export const buildTelegramBot = (token: string, gateway: ProtocolGatewayService) => {
  const bot = new Bot(token);

  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        'Ladno protocol commands:',
        '/create_session',
        '/join_session <invite_token>',
        '/give_consent <session_id>',
        '/resume_intake <session_id>',
        '/confirm_summary <session_id>',
        '/reopen_intake <session_id>',
        '/generate_proposals <session_id>',
        '/select_preferred <session_id> <BALANCED|A_LEANING|B_LEANING>',
        '/accept_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>',
        '/reject_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>',
        '/suggest_edit <session_id> <variant> <clause_id> <operation> [proposed_value]'
      ].join('\n')
    );
  });

  bot.command('create_session', async (ctx) => {
    try {
      const telegramUserId = userIdFromCtx(ctx);
      const result = await gateway.createSession(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'create_session'),
          action_type: 'create_session',
          case_id: null,
          participant_id: telegramUserId,
          payload: { command: 'create_session' }
        },
        telegramUserId
      );

      await ctx.reply(
        `Session created: ${result.session_id}\nstate: ${result.state}\ninvite_token: ${result.invite_token}`
      );
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('join_session', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /join_session <invite_token>'))) {
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      const result = await gateway.joinSession(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'join_session'),
          action_type: 'join_session',
          case_id: null,
          participant_id: telegramUserId,
          payload: { invite_token: args[0] }
        },
        telegramUserId,
        args[0]
      );

      await ctx.reply(`Joined session ${result.session_id}\nstate: ${result.state}`);
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('give_consent', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /give_consent <session_id>'))) {
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      const result = await gateway.giveConsent(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'give_consent'),
          action_type: 'give_consent',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      const session = await gateway.getSessionStatus(args[0], telegramUserId);
      await ctx.reply([`consent: ${result.state}`, renderSession(mapSessionStatusView(session))].join('\n'));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('resume_intake', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /resume_intake <session_id>'))) {
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      const intake = await gateway.resumeIntake(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'resume_intake'),
          action_type: 'resume_intake',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await ctx.reply(renderIntake(mapIntakeStatusView(intake)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('confirm_summary', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /confirm_summary <session_id>'))) {
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      const intake = await gateway.confirmSummary(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'confirm_summary'),
          action_type: 'confirm_summary',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await ctx.reply(renderIntake(mapIntakeStatusView(intake)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('reopen_intake', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /reopen_intake <session_id>'))) {
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      const intake = await gateway.reopenIntake(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'reopen_intake'),
          action_type: 'reopen_intake',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await ctx.reply(renderIntake(mapIntakeStatusView(intake)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('generate_proposals', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /generate_proposals <session_id>'))) {
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      const proposals = await gateway.generateProposals(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'generate_proposals'),
          action_type: 'generate_proposals',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await ctx.reply(renderProposalList(mapProposalListView(proposals)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('select_preferred', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        2,
        'Usage: /select_preferred <session_id> <BALANCED|A_LEANING|B_LEANING>'
      ))
    ) {
      return;
    }

    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await ctx.reply('Invalid variant type.');
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      await gateway.selectPreferred(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'select_preferred'),
          action_type: 'select_preferred',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0], variant_type: args[1] }
        },
        args[0],
        telegramUserId,
        args[1] as (typeof variantValues)[number]
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await ctx.reply(renderNegotiation(mapNegotiationRoundStatusView(status)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('accept_proposal', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        2,
        'Usage: /accept_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>'
      ))
    ) {
      return;
    }

    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await ctx.reply('Invalid variant type.');
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      await gateway.acceptProposal(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'accept_proposal'),
          action_type: 'accept_proposal',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0], variant_type: args[1] }
        },
        args[0],
        telegramUserId,
        args[1] as (typeof variantValues)[number]
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await ctx.reply(renderNegotiation(mapNegotiationRoundStatusView(status)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('reject_proposal', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        2,
        'Usage: /reject_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>'
      ))
    ) {
      return;
    }

    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await ctx.reply('Invalid variant type.');
      return;
    }

    try {
      const telegramUserId = userIdFromCtx(ctx);
      await gateway.rejectProposal(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'reject_proposal'),
          action_type: 'reject_proposal',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0], variant_type: args[1] }
        },
        args[0],
        telegramUserId,
        args[1] as (typeof variantValues)[number]
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await ctx.reply(renderNegotiation(mapNegotiationRoundStatusView(status)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  bot.command('suggest_edit', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        4,
        'Usage: /suggest_edit <session_id> <variant> <clause_id> <operation> [proposed_value]'
      ))
    ) {
      return;
    }

    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await ctx.reply('Invalid variant type.');
      return;
    }

    if (!operationValues.includes(args[3] as (typeof operationValues)[number])) {
      await ctx.reply('Invalid edit operation.');
      return;
    }

    const proposedValue = args.slice(4).join(' ') || null;

    try {
      const telegramUserId = userIdFromCtx(ctx);
      await gateway.suggestEdit(
        {
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'suggest_edit'),
          action_type: 'suggest_edit',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: {
            session_id: args[0],
            variant_type: args[1],
            clause_id: args[2],
            operation: args[3],
            proposed_value: proposedValue
          }
        },
        {
          session_id: args[0],
          telegram_user_id: telegramUserId,
          variant_type: args[1] as (typeof variantValues)[number],
          clause_id: args[2],
          operation: args[3] as (typeof operationValues)[number],
          proposed_value: proposedValue
        }
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await ctx.reply(renderNegotiation(mapNegotiationRoundStatusView(status)));
    } catch (error) {
      await ctx.reply(mapTelegramErrorText(error));
    }
  });

  return bot;
};
