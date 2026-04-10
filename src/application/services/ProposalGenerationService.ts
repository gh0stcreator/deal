import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { MediationSummaryRepository } from '../ports/MediationSummaryRepository.js';
import { ProposalMapper } from '../ports/ProposalMapper.js';
import { ProposalSetRepository } from '../ports/ProposalSetRepository.js';
import { SessionRepository } from '../ports/SessionRepository.js';
import {
  markProposalsGenerated,
  markReadyForProposal
} from '../../domain/session/stateMachine.js';
import { SessionNotFoundError } from '../../domain/session/errors.js';
import { SessionStates } from '../../domain/session/types.js';
import {
  ProposalPreconditionError,
  ProposalValidationError
} from '../../domain/proposal/errors.js';
import {
  ProposalSet,
  ProposalVariant,
  ProposalVariantTypes
} from '../../domain/proposal/types.js';
import { StructuredSynthesis } from '../../domain/synthesis/types.js';

export class ProposalGenerationService {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly summaryRepository: MediationSummaryRepository,
    private readonly proposalSetRepository: ProposalSetRepository,
    private readonly proposalMapper: ProposalMapper,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock
  ) {}

  async generateLatest(sessionId: string): Promise<ProposalSet> {
    let session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.state === SessionStates.SYNTHESIS_COMPLETED) {
      session = markReadyForProposal(session, this.clock.now());
      await this.sessionRepository.save(session);
    }

    if (session.state !== SessionStates.READY_FOR_PROPOSAL) {
      throw new ProposalPreconditionError(
        `Session must be READY_FOR_PROPOSAL, got ${session.state}.`
      );
    }

    const summary = await this.summaryRepository.findLatestByCaseId(sessionId);
    if (!summary) {
      throw new ProposalPreconditionError('Mediation summary is required before proposal generation.');
    }

    this.assertSynthesisCompleteness(summary.content);

    const variants = await this.proposalMapper.generateVariants({ synthesis: summary.content });
    this.assertProposalSetValidity(variants, summary.content);

    const latestSet = await this.proposalSetRepository.findLatestByCaseId(sessionId);

    const proposalSet: ProposalSet = {
      id: this.idGenerator.nextId(),
      case_id: sessionId,
      version: latestSet ? latestSet.version + 1 : 1,
      mediation_summary_version: summary.version,
      created_at: this.clock.now(),
      variants
    };

    await this.proposalSetRepository.save(proposalSet);

    const progressed = markProposalsGenerated(session, this.clock.now());
    await this.sessionRepository.save(progressed);

    return proposalSet;
  }

  private assertSynthesisCompleteness(summary: StructuredSynthesis): void {
    const nonEmptyArrays: Array<keyof StructuredSynthesis> = [
      'shared_goals',
      'overlapping_interests',
      'conflicting_points',
      'non_negotiables_conflicts',
      'potential_agreement_zones',
      'risk_areas'
    ];

    for (const key of nonEmptyArrays) {
      if (!Array.isArray(summary[key])) {
        throw new ProposalPreconditionError(`Synthesis field ${key} must be an array.`);
      }
    }

    if (!summary.constraints_matrix?.party_a || !summary.constraints_matrix?.party_b) {
      throw new ProposalPreconditionError('Synthesis constraints_matrix is incomplete.');
    }

    if (!summary.neutral_representation_layer?.for_party_a || !summary.neutral_representation_layer?.for_party_b) {
      throw new ProposalPreconditionError('Synthesis neutral representation layer is incomplete.');
    }
  }

  private assertProposalSetValidity(
    variants: [ProposalVariant, ProposalVariant, ProposalVariant],
    synthesis: StructuredSynthesis
  ): void {
    if (variants.length !== 3) {
      throw new ProposalValidationError('Exactly three variants are required.');
    }

    const types = new Set(variants.map((variant) => variant.variant_type));
    const expectedTypes = [
      ProposalVariantTypes.BALANCED,
      ProposalVariantTypes.A_LEANING,
      ProposalVariantTypes.B_LEANING
    ];

    for (const expected of expectedTypes) {
      if (!types.has(expected)) {
        throw new ProposalValidationError(`Missing required variant ${expected}.`);
      }
    }

    for (const variant of variants) {
      if (!variant.title.trim() || !variant.summary.trim()) {
        throw new ProposalValidationError('Variant title and summary are required.');
      }

      if (!Array.isArray(variant.clauses) || variant.clauses.length === 0) {
        throw new ProposalValidationError(`Variant ${variant.variant_type} must contain clauses.`);
      }

      const ids = new Set<string>();
      const topicToText = new Map<string, string>();

      for (const clause of variant.clauses) {
        if (
          !clause.clause_id.trim() ||
          !clause.topic.trim() ||
          !clause.clause_text.trim() ||
          !clause.rationale.trim() ||
          !clause.tradeoff_notes.trim()
        ) {
          throw new ProposalValidationError(
            `Variant ${variant.variant_type} contains incomplete clause data.`
          );
        }

        if (ids.has(clause.clause_id)) {
          throw new ProposalValidationError(
            `Variant ${variant.variant_type} has duplicate clause ids.`
          );
        }
        ids.add(clause.clause_id);

        const prev = topicToText.get(clause.topic.toLowerCase());
        if (prev) {
          const contradiction =
            /\bnot\b/.test(prev.toLowerCase()) !== /\bnot\b/.test(clause.clause_text.toLowerCase());
          if (contradiction) {
            throw new ProposalValidationError(
              `Variant ${variant.variant_type} has contradictory clauses for topic ${clause.topic}.`
            );
          }
        }
        topicToText.set(clause.topic.toLowerCase(), clause.clause_text);
      }

      if (!Array.isArray(variant.unresolved_points) || !Array.isArray(variant.risk_notes)) {
        throw new ProposalValidationError(
          `Variant ${variant.variant_type} unresolved_points and risk_notes must be arrays.`
        );
      }

      if (!variant.review_window.trim()) {
        throw new ProposalValidationError(`Variant ${variant.variant_type} requires review_window.`);
      }

      if (!variant.fallback_if_broken.continue_path.trim()) {
        throw new ProposalValidationError(
          `Variant ${variant.variant_type} requires fallback_if_broken.continue_path.`
        );
      }
    }

    const balanced = variants.find((variant) => variant.variant_type === ProposalVariantTypes.BALANCED)!;
    const aLeaning = variants.find((variant) => variant.variant_type === ProposalVariantTypes.A_LEANING)!;
    const bLeaning = variants.find((variant) => variant.variant_type === ProposalVariantTypes.B_LEANING)!;

    if (
      balanced.summary === aLeaning.summary ||
      balanced.summary === bLeaning.summary ||
      aLeaning.summary === bLeaning.summary
    ) {
      throw new ProposalValidationError('Variants must differ meaningfully in framing.');
    }

    const conflictWeaknessSignal = synthesis.non_negotiables_conflicts.length > 0;
    if (conflictWeaknessSignal) {
      for (const variant of variants) {
        if (
          !variant.risk_notes.some((note) =>
            /conflict|non-negotiable|weak|risk/i.test(note)
          )
        ) {
          throw new ProposalValidationError(
            'Conflicting non-negotiables must be reflected in proposal risk notes.'
          );
        }
      }
    }
  }
}
