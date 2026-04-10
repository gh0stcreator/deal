import {
  ProblemSynthesisSnapshot,
  SynthesisReviewSignal
} from '../../domain/synthesis/types.js';

export interface SynthesisReviewRepository {
  findLatestProblemSynthesis(caseId: string): Promise<ProblemSynthesisSnapshot | null>;
  saveProblemSynthesis(snapshot: ProblemSynthesisSnapshot): Promise<void>;
  saveOrUpdateReviewSignal(signal: SynthesisReviewSignal): Promise<void>;
  listReviewSignals(caseId: string, synthesisVersion: number): Promise<SynthesisReviewSignal[]>;
}
