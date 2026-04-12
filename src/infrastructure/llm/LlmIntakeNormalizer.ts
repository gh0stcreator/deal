import {
  IntakeNormalizer,
  IntakeNormalizationResult,
  IntakePromptContext
} from '../../application/ports/IntakeNormalizer.js';
import { IntakeField, NormalizedPositionModel } from '../../domain/intake/types.js';
import { mediatorSystemPrompt } from './prompts/mediatorSystemPrompt.js';
import { AnthropicClient } from './AnthropicClient.js';

const FIELD_DESCRIPTION: Record<IntakeField, string> = {
  facts: 'situation_facts: что фактически происходит, без оценки',
  interpretations: 'tension_point: где главное напряжение/трение',
  interests: 'important_need_or_interest: что важно по сути',
  constraints: 'hard_constraint: что неприемлемо',
  boundaries: 'hard_constraint: что неприемлемо',
  desired_outcome: 'desired_outcome: какой результат рабочий',
  acceptable_concessions: 'acceptable_flexibility: где возможна гибкость',
  non_negotiables: 'hard_constraint: что неприемлемо'
};

const extractJsonObject = (value: string): string | null => {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return value.slice(start, end + 1);
  }
  return null;
};

const safeText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export class LlmIntakeNormalizer implements IntakeNormalizer {
  constructor(private readonly anthropic: AnthropicClient = new AnthropicClient()) {}

  async normalizeField(
    field: IntakeField,
    rawValue: string,
    context?: IntakePromptContext
  ): Promise<IntakeNormalizationResult> {
    const questionText = context?.questionText?.trim() || FIELD_DESCRIPTION[field];
    const userPrompt = [
      'Задача: по сообщению пользователя верни строго JSON без комментариев.',
      `Текущий шаг intake: ${FIELD_DESCRIPTION[field]}.`,
      'Верни JSON формата:',
      '{"reflection":"...", "extractedValue":"...", "needsClarification":true|false}',
      'Правила:',
      '- reflection: максимум 3 предложения, спокойный и точный тон.',
      '- extractedValue: короткая структурная формулировка для этого шага.',
      '- needsClarification=true только если данных недостаточно для фиксации шага.',
      '- Не используй слово "понимаю" как заполнитель.',
      '- Не повторяй текст пользователя дословно.',
      '',
      `Пользователь отвечал на вопрос медиатора: «${questionText}»`,
      `Его ответ: «${rawValue.trim()}»`,
      '',
      'Напиши рефлексию в 2-3 предложениях от лица медиатора.',
      'Требования к рефлексии:',
      '- Отрази смысл, не слова.',
      '- Назови что услышано на уровне интереса или потребности, не позиции.',
      '- Последняя фраза: «Я правильно понял?»',
      '',
      'Ответ: только JSON.'
    ].join('\n');

    const response = await this.anthropic.ask(
      context?.systemPrompt ?? mediatorSystemPrompt,
      userPrompt
    );
    const jsonText = extractJsonObject(response);
    if (!jsonText) {
      throw new Error('LLM intake normalizer returned non-JSON response.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error('LLM intake normalizer JSON parse failed.');
    }

    const reflection = safeText((parsed as Record<string, unknown>).reflection);
    const extractedValue = safeText((parsed as Record<string, unknown>).extractedValue);
    const needsClarification = Boolean((parsed as Record<string, unknown>).needsClarification);

    return {
      reflection:
        reflection || 'Слышу вас. Я правильно понял суть?',
      extractedValue,
      needsClarification: needsClarification || extractedValue.length === 0
    };
  }

  async generateSummary(
    model: NormalizedPositionModel,
    context?: IntakePromptContext
  ): Promise<string> {
    const userPrompt = [
      'Собери короткое нейтральное резюме intake для подтверждения пользователем.',
      'Тон: спокойный, точный, без обвинений.',
      'Формат: 5-7 коротких строк, без markdown.',
      '',
      'Данные:',
      `facts: ${model.facts}`,
      `tension_point: ${model.interpretations}`,
      `important_need_or_interest: ${model.interests}`,
      `hard_constraint: ${model.constraints}`,
      `boundaries: ${model.boundaries}`,
      `desired_outcome: ${model.desired_outcome}`,
      `acceptable_flexibility: ${model.acceptable_concessions}`,
      `non_negotiables: ${model.non_negotiables}`
    ].join('\n');

    const response = await this.anthropic.ask(
      context?.systemPrompt ?? mediatorSystemPrompt,
      userPrompt
    );
    return response.trim();
  }
}
