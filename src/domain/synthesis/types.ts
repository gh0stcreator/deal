export interface ConstraintsMatrix {
  party_a: string[];
  party_b: string[];
}

export interface NeutralizedPerspective {
  how_the_other_side_likely_sees_the_situation: string;
  what_seems_important_to_the_other_side: string[];
  where_expectations_differ: string[];
}

export interface NeutralRepresentationLayer {
  for_party_a: NeutralizedPerspective;
  for_party_b: NeutralizedPerspective;
}

export interface StructuredSynthesis {
  shared_goals: string[];
  overlapping_interests: string[];
  conflicting_points: string[];
  constraints_matrix: ConstraintsMatrix;
  non_negotiables_conflicts: string[];
  potential_agreement_zones: string[];
  risk_areas: string[];
  neutral_representation_layer: NeutralRepresentationLayer;
}

export interface MediationSummary {
  id: string;
  caseId: string;
  version: number;
  content: StructuredSynthesis;
  createdAt: Date;
}
