import { invariant } from '../invariant.ts';
import type { ThreadId, ViewerId, ViewerLogin } from './work.ts';

export type IssueId = string & { readonly brand: 'IssueId' };

export type PullRequestId = string & { readonly brand: 'PullRequestId' };

export type DetailSubjectKey = string & { readonly brand: 'DetailSubjectKey' };

export type DetailCoverage =
  | 'notRequested'
  | 'loading'
  | 'loaded'
  | 'partial'
  | 'unavailable'
  | 'unsupported'
  | 'failed';

type IssueCommentId = string & { readonly brand: 'IssueCommentId' };

export interface IssueSubject {
  id: IssueId;
  number: number;
  url: string;
}

export interface IssueOverview {
  id: IssueId;
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string | null;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
  labels: { names: string[]; totalCount: number };
  assignees: { logins: string[]; totalCount: number };
  digest: string;
}

export interface IssueComment {
  id: IssueCommentId;
  author: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
  url: string;
  digest: string;
}

export interface IssueCommentPage {
  records: IssueComment[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface DetailViewer {
  id: ViewerId;
  login: ViewerLogin;
}

export type IssueDetailRead =
  | {
      kind: 'issue';
      viewer: DetailViewer;
      subject: IssueSubject;
      overview: IssueOverview;
      comments: IssueCommentPage;
    }
  | { kind: 'unavailable' | 'unsupported'; viewer: DetailViewer };

export interface PullRequestPage<TRecord> {
  records: TRecord[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PullRequestRef {
  id: PullRequestId;
  headOid: string;
  baseOid: string;
}

interface PullRequestBranch {
  refName: string;
  oid: string;
}

export type PullRequestReviewer =
  | { kind: 'account'; typeName: 'User' | 'Bot' | 'Mannequin'; login: string }
  | { kind: 'team'; name: string }
  | { kind: 'other'; typeName: string };

export interface PullRequestOverview {
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
  base: PullRequestBranch;
  head: PullRequestBranch;
  labels: { names: string[]; totalCount: number };
  assignees: { logins: string[]; totalCount: number };
  reviewRequests: { reviewers: PullRequestReviewer[]; totalCount: number };
  reviewDecision: 'approved' | 'changesRequested' | 'reviewRequired' | null;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  mergeStateStatus:
    | 'behind'
    | 'blocked'
    | 'clean'
    | 'dirty'
    | 'draft'
    | 'hasHooks'
    | 'unstable'
    | 'unknown';
  checksUrl: string;
  digest: string;
}

export interface PullRequestCommit {
  oid: string;
  headline: string;
  author: string | null;
  authoredDate: string;
  url: string;
}

export type PullRequestCheck =
  | {
      kind: 'checkRun';
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      url: string;
      databaseId: number | null;
    }
  | {
      kind: 'statusContext';
      context: string;
      state: string;
      description: string | null;
      targetUrl: string | null;
    };

export interface PullRequestCheckRollup {
  state: string;
  commitOid: string;
  checks: PullRequestPage<PullRequestCheck>;
}

export interface PullRequestFile {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
}

interface PullRequestFileTotals {
  changedFiles: number;
  additions: number;
  deletions: number;
}

export type PullRequestDetailRead =
  | {
      kind: 'overview';
      viewer: DetailViewer;
      pullRequest: PullRequestRef;
      overview: PullRequestOverview;
    }
  | {
      kind: 'commits';
      viewer: DetailViewer;
      pullRequest: PullRequestRef;
      commits: PullRequestPage<PullRequestCommit>;
    }
  | {
      kind: 'checks';
      viewer: DetailViewer;
      pullRequest: PullRequestRef;
      rollup: PullRequestCheckRollup | null;
    }
  | {
      kind: 'files';
      viewer: DetailViewer;
      pullRequest: PullRequestRef;
      totals: PullRequestFileTotals;
      files: PullRequestPage<PullRequestFile> | null;
    }
  | { kind: 'unavailable' | 'unsupported'; viewer: DetailViewer };

const isIssueId = (value: string): value is IssueId => value !== '';

const isPullRequestId = (value: string): value is PullRequestId => value !== '';

const isIssueCommentId = (value: string): value is IssueCommentId => value !== '';

const isDetailSubjectKey = (value: string): value is DetailSubjectKey => value !== '';

export const toDetailSubjectKey = (host: string, threadId: ThreadId): DetailSubjectKey => {
  const key = `${host}@${threadId}`;

  invariant(isDetailSubjectKey(key), 'A detail subject key must not be empty.');

  return key;
};

export const toIssueId = (value: string): IssueId => {
  invariant(isIssueId(value), 'An issue ID must not be empty.');

  return value;
};

export const toPullRequestId = (value: string): PullRequestId => {
  invariant(isPullRequestId(value), 'A pull request ID must not be empty.');

  return value;
};

export const toIssueCommentId = (value: string): IssueCommentId => {
  invariant(isIssueCommentId(value), 'An issue comment ID must not be empty.');

  return value;
};
