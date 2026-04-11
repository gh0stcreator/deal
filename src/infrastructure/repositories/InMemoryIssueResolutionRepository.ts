import { IssueResolutionRepository } from '../../application/ports/IssueResolutionRepository.js';
import {
  IssueResolutionLoop,
  IssueResolutionReaction
} from '../../domain/issue/types.js';

export class InMemoryIssueResolutionRepository implements IssueResolutionRepository {
  private readonly loops = new Map<string, IssueResolutionLoop[]>();
  private readonly reactions = new Map<string, IssueResolutionReaction[]>();

  async findLatestLoopByCaseId(caseId: string): Promise<IssueResolutionLoop | null> {
    const entries = this.loops.get(caseId) ?? [];
    if (entries.length === 0) {
      return null;
    }
    return structuredClone(entries[entries.length - 1]);
  }

  async saveLoop(loop: IssueResolutionLoop): Promise<void> {
    const entries = this.loops.get(loop.caseId) ?? [];
    entries.push(structuredClone(loop));
    entries.sort((a, b) => a.version - b.version);
    this.loops.set(loop.caseId, entries);
  }

  async listLoopsByCaseId(caseId: string): Promise<IssueResolutionLoop[]> {
    return (this.loops.get(caseId) ?? []).map((entry) => structuredClone(entry));
  }

  async saveOrUpdateReaction(reaction: IssueResolutionReaction): Promise<void> {
    const entries = this.reactions.get(reaction.caseId) ?? [];
    const index = entries.findIndex(
      (entry) =>
        entry.caseId === reaction.caseId &&
        entry.loopVersion === reaction.loopVersion &&
        entry.participantId === reaction.participantId &&
        entry.optionId === reaction.optionId
    );
    if (index >= 0) {
      entries[index] = structuredClone(reaction);
    } else {
      entries.push(structuredClone(reaction));
    }
    entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    this.reactions.set(reaction.caseId, entries);
  }

  async listReactions(caseId: string, loopVersion: number): Promise<IssueResolutionReaction[]> {
    const entries = this.reactions.get(caseId) ?? [];
    return entries
      .filter((entry) => entry.loopVersion === loopVersion)
      .map((entry) => structuredClone(entry));
  }
}
