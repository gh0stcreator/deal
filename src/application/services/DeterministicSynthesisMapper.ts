import { SynthesisMapper } from '../ports/SynthesisMapper.js';
import { NormalizedPositionModel } from '../../domain/intake/types.js';
import { StructuredSynthesis } from '../../domain/synthesis/types.js';

type ThemeId =
  | 'financial_stability'
  | 'time_predictability'
  | 'communication_quality'
  | 'trust_reliability'
  | 'autonomy_control'
  | 'workload_capacity'
  | 'quality_expectation'
  | 'legal_process'
  | 'safety_respect';

const THEME_LABELS: Record<ThemeId, string> = {
  financial_stability: 'Financial stability',
  time_predictability: 'Time predictability',
  communication_quality: 'Communication quality',
  trust_reliability: 'Trust and reliability',
  autonomy_control: 'Autonomy and control',
  workload_capacity: 'Workload capacity',
  quality_expectation: 'Quality expectations',
  legal_process: 'Formal/legal process',
  safety_respect: 'Safety and mutual respect'
};

const THEME_KEYWORDS: Array<{ theme: ThemeId; keywords: string[] }> = [
  { theme: 'financial_stability', keywords: ['money', 'budget', 'cost', 'price', 'pay', 'rent'] },
  { theme: 'time_predictability', keywords: ['time', 'deadline', 'schedule', 'delay', 'urgent'] },
  { theme: 'communication_quality', keywords: ['communicat', 'tone', 'message', 'inform'] },
  { theme: 'trust_reliability', keywords: ['trust', 'reliable', 'promise', 'commitment'] },
  { theme: 'autonomy_control', keywords: ['control', 'independ', 'decision', 'authority'] },
  { theme: 'workload_capacity', keywords: ['capacity', 'load', 'effort', 'resource'] },
  { theme: 'quality_expectation', keywords: ['quality', 'standard', 'accuracy', 'result'] },
  { theme: 'legal_process', keywords: ['legal', 'law', 'contract', 'formal'] },
  { theme: 'safety_respect', keywords: ['safe', 'respect', 'boundary', 'harm'] }
];

interface FieldThemes {
  interests: Set<ThemeId>;
  desired_outcome: Set<ThemeId>;
  interpretations: Set<ThemeId>;
  constraints: Set<ThemeId>;
  boundaries: Set<ThemeId>;
  acceptable_concessions: Set<ThemeId>;
  non_negotiables: Set<ThemeId>;
}

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[\n,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);

const themesForText = (value: string): Set<ThemeId> => {
  const themes = new Set<ThemeId>();
  const tokens = tokenize(value);

  for (const token of tokens) {
    for (const entry of THEME_KEYWORDS) {
      if (entry.keywords.some((keyword) => token.includes(keyword))) {
        themes.add(entry.theme);
      }
    }
  }

  return themes;
};

const intersection = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((value) => b.has(value));
const difference = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((value) => !b.has(value));

const toLabels = (themes: Iterable<ThemeId>): string[] =>
  [...new Set(themes)]
    .sort()
    .map((theme) => THEME_LABELS[theme]);

const combine = (...sets: Set<ThemeId>[]): Set<ThemeId> => {
  const out = new Set<ThemeId>();
  for (const set of sets) {
    for (const value of set) {
      out.add(value);
    }
  }
  return out;
};

const polarityEntries = (value: string): Array<{ key: ThemeId; positive: boolean }> => {
  const entries: Array<{ key: ThemeId; positive: boolean }> = [];

  for (const token of tokenize(value)) {
    const positive = !/\b(no|not|without)\b/.test(token);
    for (const keywordEntry of THEME_KEYWORDS) {
      if (keywordEntry.keywords.some((keyword) => token.includes(keyword))) {
        entries.push({ key: keywordEntry.theme, positive });
      }
    }
  }

  return entries;
};

const mapFieldThemes = (model: NormalizedPositionModel): FieldThemes => ({
  interests: themesForText(model.interests),
  desired_outcome: themesForText(model.desired_outcome),
  interpretations: themesForText(model.interpretations),
  constraints: themesForText(model.constraints),
  boundaries: themesForText(model.boundaries),
  acceptable_concessions: themesForText(model.acceptable_concessions),
  non_negotiables: themesForText(model.non_negotiables)
});

const buildPerspective = (
  other: FieldThemes,
  self: FieldThemes
): StructuredSynthesis['neutral_representation_layer']['for_party_a'] => {
  const otherPriorities = toLabels(combine(other.interests, other.desired_outcome)).slice(0, 3);
  const expectationDiff = toLabels(
    combine(
      new Set(difference(self.desired_outcome, other.desired_outcome)),
      new Set(difference(other.desired_outcome, self.desired_outcome))
    )
  );

  return {
    how_the_other_side_likely_sees_the_situation:
      otherPriorities.length > 0
        ? `The other side appears focused on ${otherPriorities.join(', ')} within practical constraints.`
        : 'The other side appears focused on reducing uncertainty and preserving workable terms.',
    what_seems_important_to_the_other_side: otherPriorities,
    where_expectations_differ: expectationDiff
  };
};

export class DeterministicSynthesisMapper implements SynthesisMapper {
  async synthesize(input: {
    partyA: NormalizedPositionModel;
    partyB: NormalizedPositionModel;
  }): Promise<StructuredSynthesis> {
    const a = mapFieldThemes(input.partyA);
    const b = mapFieldThemes(input.partyB);

    const sharedGoals = toLabels(intersection(a.desired_outcome, b.desired_outcome));
    const overlappingInterests = toLabels(intersection(a.interests, b.interests));

    const aNonNeg = polarityEntries(input.partyA.non_negotiables);
    const bNonNeg = polarityEntries(input.partyB.non_negotiables);

    const nonNegotiablesConflicts = toLabels(
      aNonNeg
        .flatMap((aEntry) =>
          bNonNeg
            .filter((bEntry) => bEntry.key === aEntry.key && bEntry.positive !== aEntry.positive)
            .map((bEntry) => bEntry.key)
        )
    );

    const conflictingPoints = toLabels(
      combine(
        new Set(difference(a.interpretations, b.interpretations)),
        new Set(difference(b.interpretations, a.interpretations)),
        new Set(nonNegotiablesConflicts.map((label) => {
          const match = (Object.entries(THEME_LABELS) as Array<[ThemeId, string]>).find(
            ([, value]) => value === label
          );
          return match ? match[0] : 'quality_expectation';
        }))
      )
    );

    const potentialAgreementZones = toLabels(
      combine(
        new Set(intersection(a.acceptable_concessions, b.acceptable_concessions)),
        new Set(intersection(a.interests, b.interests)),
        new Set(intersection(a.desired_outcome, b.desired_outcome))
      )
    );

    const riskAreas = [
      ...(overlappingInterests.length === 0 && sharedGoals.length === 0
        ? ['Low overlap in articulated goals and interests']
        : []),
      ...(nonNegotiablesConflicts.length > 0
        ? ['Direct conflict in non-negotiable conditions']
        : []),
      ...(potentialAgreementZones.length === 0
        ? ['No immediate agreement zone detected without concessions']
        : [])
    ];

    const forPartyA = buildPerspective(b, a);
    const forPartyB = buildPerspective(a, b);

    const sharedImportantCount = Math.min(
      forPartyA.what_seems_important_to_the_other_side.length,
      forPartyB.what_seems_important_to_the_other_side.length
    );
    const sharedDiffCount = Math.min(
      forPartyA.where_expectations_differ.length,
      forPartyB.where_expectations_differ.length
    );

    return {
      shared_goals: sharedGoals,
      overlapping_interests: overlappingInterests,
      conflicting_points: conflictingPoints,
      constraints_matrix: {
        party_a: toLabels(combine(a.constraints, a.boundaries)),
        party_b: toLabels(combine(b.constraints, b.boundaries))
      },
      non_negotiables_conflicts: nonNegotiablesConflicts,
      potential_agreement_zones: potentialAgreementZones,
      risk_areas: riskAreas,
      neutral_representation_layer: {
        for_party_a: {
          ...forPartyA,
          what_seems_important_to_the_other_side:
            forPartyA.what_seems_important_to_the_other_side.slice(0, sharedImportantCount),
          where_expectations_differ: forPartyA.where_expectations_differ.slice(
            0,
            sharedDiffCount
          )
        },
        for_party_b: {
          ...forPartyB,
          what_seems_important_to_the_other_side:
            forPartyB.what_seems_important_to_the_other_side.slice(0, sharedImportantCount),
          where_expectations_differ: forPartyB.where_expectations_differ.slice(
            0,
            sharedDiffCount
          )
        }
      }
    };
  }
}
