import { ProposalMapper } from '../ports/ProposalMapper.js';
import {
  ProposalClause,
  ProposalVariant,
  ProposalVariantTypes
} from '../../domain/proposal/types.js';
import { StructuredSynthesis } from '../../domain/synthesis/types.js';

const createClause = (
  variantKey: string,
  idx: number,
  topic: string,
  clauseText: string,
  rationale: string,
  tradeoffNotes: string
): ProposalClause => ({
  clause_id: `${variantKey.toLowerCase()}_clause_${idx + 1}`,
  topic,
  clause_text: clauseText,
  rationale,
  tradeoff_notes: tradeoffNotes
});

const unique = (items: string[]): string[] => [...new Set(items.filter((item) => item.trim().length > 0))];

const bounded = (items: string[], fallback: string): string[] => {
  const filtered = unique(items);
  return filtered.length > 0 ? filtered : [fallback];
};

export class DeterministicProposalMapper implements ProposalMapper {
  async generateVariants(input: {
    synthesis: StructuredSynthesis;
  }): Promise<[ProposalVariant, ProposalVariant, ProposalVariant]> {
    const s = input.synthesis;

    const shared = bounded(
      [...s.shared_goals, ...s.overlapping_interests, ...s.potential_agreement_zones],
      'Stabilize interactions with a limited trial arrangement'
    );

    const unresolved = bounded(
      [...s.conflicting_points, ...s.non_negotiables_conflicts],
      'No high-friction unresolved points explicitly identified'
    );

    const riskNotes = bounded(s.risk_areas, 'Execution risk remains low if review checkpoints are respected');

    const constraintsA = bounded(s.constraints_matrix.party_a, 'Party A constraints are unspecified');
    const constraintsB = bounded(s.constraints_matrix.party_b, 'Party B constraints are unspecified');

    const minimalFallback = {
      agreed_now: shared.slice(0, 2),
      unresolved: unresolved.slice(0, 3),
      fixed_boundaries: bounded(s.non_negotiables_conflicts, 'Respect explicit boundaries and pause escalation'),
      continue_path:
        'Apply a short review window, keep only verifiable commitments, and escalate unresolved items to a bounded follow-up session.'
    };

    const balancedClauses = [
      createClause(
        'balanced',
        0,
        'Shared goals',
        `Both parties commit to the following immediate goals: ${shared.slice(0, 3).join('; ')}.`,
        'Anchors the proposal in documented overlap and feasible agreement space.',
        'Requires each side to defer at least one preferred outcome until review.'
      ),
      createClause(
        'balanced',
        1,
        'Constraint compatibility',
        `Execution plan must satisfy Party A constraints (${constraintsA.slice(0, 2).join('; ')}) and Party B constraints (${constraintsB.slice(0, 2).join('; ')}).`,
        'Prevents proposals that are structurally unacceptable to either side.',
        'Scope is reduced to what both sides can realistically sustain.'
      ),
      createClause(
        'balanced',
        2,
        'Review and correction',
        'A fixed review checkpoint occurs within 14 days with measurable outcomes and explicit unresolved-point tracking.',
        'Ensures reviewability and keeps unresolved conflict visible instead of implicit.',
        'Short timeline may postpone deeper concerns to later rounds.'
      )
    ];

    const aLeaningClauses = [
      createClause(
        'a_leaning',
        0,
        'Priority weighting',
        `Initial execution prioritizes Party A feasibility constraints (${constraintsA.slice(0, 2).join('; ')}) while preserving baseline acceptability for Party B.`,
        'Introduces controlled asymmetry without violating negotiability.',
        'Party B receives stronger review correction rights at checkpoint.'
      ),
      createClause(
        'a_leaning',
        1,
        'Protected overlap',
        `Non-disputed overlap remains mandatory: ${shared.slice(0, 2).join('; ')}.`,
        'Keeps variant tied to shared feasibility and avoids unilateral terms.',
        'Party A receives earlier implementation; Party B receives explicit rollback trigger.'
      ),
      createClause(
        'a_leaning',
        2,
        'Dispute containment',
        `Items in dispute (${unresolved.slice(0, 2).join('; ')}) are isolated from immediate commitments and moved to structured follow-up.`,
        'Prevents high-friction points from blocking near-term progress.',
        'Some Party B priorities are deferred rather than resolved immediately.'
      )
    ];

    const bLeaningClauses = [
      createClause(
        'b_leaning',
        0,
        'Priority weighting',
        `Initial execution prioritizes Party B feasibility constraints (${constraintsB.slice(0, 2).join('; ')}) while preserving baseline acceptability for Party A.`,
        'Introduces controlled asymmetry without violating negotiability.',
        'Party A receives stronger review correction rights at checkpoint.'
      ),
      createClause(
        'b_leaning',
        1,
        'Protected overlap',
        `Non-disputed overlap remains mandatory: ${shared.slice(0, 2).join('; ')}.`,
        'Keeps variant tied to shared feasibility and avoids unilateral terms.',
        'Party B receives earlier implementation; Party A receives explicit rollback trigger.'
      ),
      createClause(
        'b_leaning',
        2,
        'Dispute containment',
        `Items in dispute (${unresolved.slice(0, 2).join('; ')}) are isolated from immediate commitments and moved to structured follow-up.`,
        'Prevents high-friction points from blocking near-term progress.',
        'Some Party A priorities are deferred rather than resolved immediately.'
      )
    ];

    const balanced: ProposalVariant = {
      variant_type: ProposalVariantTypes.BALANCED,
      title: 'Balanced Feasibility Proposal',
      summary: 'Symmetric, reviewable structure maximizing shared feasibility without suppressing conflicts.',
      clauses: balancedClauses,
      unresolved_points: unresolved,
      risk_notes: riskNotes,
      review_window: '14 days',
      fallback_if_broken: minimalFallback
    };

    const aLeaning: ProposalVariant = {
      variant_type: ProposalVariantTypes.A_LEANING,
      title: 'A-Leaning Feasible Proposal',
      summary: 'Prioritizes Party A constraints while preserving a viable path for Party B.',
      clauses: aLeaningClauses,
      unresolved_points: unresolved,
      risk_notes: riskNotes,
      review_window: '14 days',
      fallback_if_broken: minimalFallback
    };

    const bLeaning: ProposalVariant = {
      variant_type: ProposalVariantTypes.B_LEANING,
      title: 'B-Leaning Feasible Proposal',
      summary: 'Prioritizes Party B constraints while preserving a viable path for Party A.',
      clauses: bLeaningClauses,
      unresolved_points: unresolved,
      risk_notes: riskNotes,
      review_window: '14 days',
      fallback_if_broken: minimalFallback
    };

    return [balanced, aLeaning, bLeaning];
  }
}
