import {
  IssueResolutionLoop,
  IssueResolutionReaction
} from '../../domain/issue/types.js';

export interface IssueResolutionRepository {
  findLatestLoopByCaseId(caseId: string): Promise<IssueResolutionLoop | null>;
  saveLoop(loop: IssueResolutionLoop): Promise<void>;
  listLoopsByCaseId(caseId: string): Promise<IssueResolutionLoop[]>;
  saveOrUpdateReaction(reaction: IssueResolutionReaction): Promise<void>;
  listReactions(caseId: string, loopVersion: number): Promise<IssueResolutionReaction[]>;
}
