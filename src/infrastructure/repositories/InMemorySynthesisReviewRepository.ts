import { SynthesisReviewRepository } from '../../application/ports/SynthesisReviewRepository.js';
import {
  ProblemSynthesisSnapshot,
  SynthesisReviewSignal
} from '../../domain/synthesis/types.js';

export class InMemorySynthesisReviewRepository implements SynthesisReviewRepository {
  private readonly snapshots = new Map<string, ProblemSynthesisSnapshot[]>();
  private readonly signals = new Map<string, SynthesisReviewSignal[]>();

  async findLatestProblemSynthesis(caseId: string): Promise<ProblemSynthesisSnapshot | null> {
    const entries = this.snapshots.get(caseId) ?? [];
    if (entries.length === 0) {
      return null;
    }
    return structuredClone(entries[entries.length - 1]);
  }

  async saveProblemSynthesis(snapshot: ProblemSynthesisSnapshot): Promise<void> {
    const entries = this.snapshots.get(snapshot.caseId) ?? [];
    entries.push(structuredClone(snapshot));
    entries.sort((a, b) => a.version - b.version);
    this.snapshots.set(snapshot.caseId, entries);
  }

  async saveOrUpdateReviewSignal(signal: SynthesisReviewSignal): Promise<void> {
    const entries = this.signals.get(signal.caseId) ?? [];
    const existingIndex = entries.findIndex(
      (entry) =>
        entry.caseId === signal.caseId &&
        entry.participantId === signal.participantId &&
        entry.synthesisVersion === signal.synthesisVersion
    );

    if (existingIndex >= 0) {
      entries[existingIndex] = structuredClone(signal);
    } else {
      entries.push(structuredClone(signal));
    }

    entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    this.signals.set(signal.caseId, entries);
  }

  async listReviewSignals(caseId: string, synthesisVersion: number): Promise<SynthesisReviewSignal[]> {
    const entries = this.signals.get(caseId) ?? [];
    return entries
      .filter((entry) => entry.synthesisVersion === synthesisVersion)
      .map((entry) => structuredClone(entry));
  }
}
