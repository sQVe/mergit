import { invariant } from '../invariant.ts';
import type { ViewerId, ViewerLogin } from './work.ts';

export type IssueId = string & { readonly brand: 'IssueId' };

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

interface IssueViewer {
  id: ViewerId;
  login: ViewerLogin;
}

export type IssueDetailRead =
  | {
      kind: 'issue';
      viewer: IssueViewer;
      subject: IssueSubject;
      overview: IssueOverview;
      comments: IssueCommentPage;
    }
  | { kind: 'unavailable' | 'unsupported'; viewer: IssueViewer };

const isIssueId = (value: string): value is IssueId => value !== '';

const isIssueCommentId = (value: string): value is IssueCommentId => value !== '';

export const toIssueId = (value: string): IssueId => {
  invariant(isIssueId(value), 'An issue ID must not be empty.');

  return value;
};

export const toIssueCommentId = (value: string): IssueCommentId => {
  invariant(isIssueCommentId(value), 'An issue comment ID must not be empty.');

  return value;
};
