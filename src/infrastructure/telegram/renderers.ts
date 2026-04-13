import {
  ProblemSynthesisView,
  ProtocolGatewayService
} from '../../application/services/ProtocolGatewayService.js';
import {
  mapIntakeStatusView,
  mapNegotiationRoundStatusView,
  mapProposalListView
} from '../transport/viewMappers.js';

export const renderIntake = (view: ReturnType<typeof mapIntakeStatusView>) =>
  [
    `intake: ${view.intake_id}`,
    `state: ${view.state}`,
    `current_field: ${view.current_field ?? 'none'}`,
    `summary_ready: ${view.has_generated_summary ? 'yes' : 'no'}`,
    `confirmed: ${view.has_confirmed_summary ? 'yes' : 'no'}`,
    `version: ${view.version}`
  ].join('\n');

export const renderProposalList = (view: ReturnType<typeof mapProposalListView>) =>
  [
    `case: ${view.case_id}`,
    `proposal_set_version: ${view.proposal_set_version}`,
    ...view.variants.map(
      (variant) => `- ${variant.variant_type}: ${variant.title} | ${variant.summary}`
    )
  ].join('\n');

export const renderNegotiation = (view: ReturnType<typeof mapNegotiationRoundStatusView>) =>
  [
    `session: ${view.session_id}`,
    `state: ${view.session_state}`,
    `round: ${view.current_round_number ?? 'pending'}`,
    `proposal_set_version: ${view.proposal_set_version}`,
    `round_status: ${view.round_status ?? 'none'}`
  ].join('\n');

export const renderProblemSynthesis = (view: ProblemSynthesisView): string =>
  [
    'Похоже, вы оба хотите...',
    view.shared_goal,
    '',
    'У вас уже есть общее в том, что...',
    `- ${view.agreement_points.join('\n- ')}`,
    '',
    'Главная точка напряжения сейчас...',
    view.primary_tension_point,
    '',
    'Похоже, рабочее поле для договорённости может быть таким...',
    view.possible_zone_of_agreement
  ].join('\n');

export const renderIssueFraming = (
  loop: Awaited<ReturnType<ProtocolGatewayService['generateIssueResolutionLoop']>>
): string =>
  [
    'Похоже, основной вопрос сейчас такой:',
    loop.issue_title,
    '',
    'С одной стороны важно...',
    loop.side_a_priority,
    '',
    'С другой стороны важно...',
    loop.side_b_priority
  ].join('\n');

export const renderIssueOption = (
  option: Awaited<ReturnType<ProtocolGatewayService['generateIssueResolutionLoop']>>['options'][number]
): string =>
  [
    option.description,
    '',
    `Что придётся учесть: ${option.tradeoff_note}`
  ].join('\n');

export const renderDraftAgreement = (
  draft: Awaited<ReturnType<ProtocolGatewayService['generateDraftAgreement']>>
): string =>
  [
    'Похоже, вы пришли к такому варианту:',
    '',
    ...draft.agreed_actions.map((action) => `— ${action}`),
    '',
    'Границы:',
    ...draft.boundaries.map((entry) => `— ${entry}`),
    '',
    'Если что-то пойдёт не так:',
    `— ${draft.fallback_rule}`,
    '',
    'Можно пересмотреть:',
    `— ${draft.review_point}`,
    '',
    'Подтверждаем договорённость?'
  ].join('\n');
