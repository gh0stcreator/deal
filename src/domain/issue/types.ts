export const IssueReactionTypes = {
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  REQUEST_CHANGE: 'REQUEST_CHANGE'
} as const;

export type IssueReactionType =
  (typeof IssueReactionTypes)[keyof typeof IssueReactionTypes];

export const IssueLoopStatuses = {
  IN_PROGRESS: 'IN_PROGRESS',
  WORKABLE_PATH_FOUND: 'WORKABLE_PATH_FOUND',
  NO_WORKABLE_PATH: 'NO_WORKABLE_PATH'
} as const;

export type IssueLoopStatus = (typeof IssueLoopStatuses)[keyof typeof IssueLoopStatuses];

export interface IssueResolutionOption {
  option_id: string;
  title: string;
  description: string;
  tradeoff_note: string;
}

export interface IssueResolutionLoop {
  id: string;
  caseId: string;
  version: number;
  synthesisVersion: number;
  issueTitle: string;
  sideAPriority: string;
  sideBPriority: string;
  issueConstraints: string[];
  options: IssueResolutionOption[];
  optionTradeoffs: string[];
  createdAt: Date;
}

export interface IssueResolutionReaction {
  id: string;
  caseId: string;
  loopVersion: number;
  participantId: string;
  optionId: string;
  reactionType: IssueReactionType;
  changeRequest: string | null;
  createdAt: Date;
}
