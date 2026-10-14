import { invariant } from '../invariant.ts';
import type { TreeRow } from './workTree.ts';
import { listedRepositories } from './workTree.ts';

export { buildTree, flattenTree, groupings, treeRows } from './workTree.ts';
export type { Grouping, NodeRow, ThreadRow, TreeRow } from './workTree.ts';

export type ThreadId = string & { readonly brand: 'ThreadId' };

export type ViewerLogin = string & { readonly brand: 'ViewerLogin' };

export interface NotificationThread {
  id: ThreadId;
  reason: string;
  unread: boolean;
  updatedAt: string;
  lastReadAt: string | null;
  title: string;
  subjectType: string;
  subjectUrl: string | null;
  repository: string;
}

type SubjectState = 'open' | 'closed' | 'merged';

export interface SubjectFacts {
  state: SubjectState;
  author: string | null;
  latestActor: string | null;
}

export type BrowserPage = { repository: string } & (
  | { kind: 'item'; number: number }
  | { kind: 'commit'; sha: string }
  | { kind: 'releases' }
  | { kind: 'actions' }
  | { kind: 'repo' }
);

const isThreadId = (value: string): value is ThreadId => value !== '';

const isViewerLogin = (value: string): value is ViewerLogin => value !== '';

export const toThreadId = (value: string): ThreadId => {
  invariant(isThreadId(value), 'A thread ID must not be empty.');

  return value;
};

export const toViewerLogin = (value: string): ViewerLogin => {
  invariant(isViewerLogin(value), 'A viewer login must not be empty.');

  return value;
};

export const isDoneOnGitHub = (thread: NotificationThread): boolean =>
  !thread.unread && thread.lastReadAt === null;

export const isDoneLocally = (
  thread: NotificationThread,
  doneRecords: ReadonlyMap<ThreadId, string>,
): boolean => doneRecords.get(thread.id) === thread.updatedAt;

export const selectOpenThreads = (
  threads: NotificationThread[],
  doneRecords: ReadonlyMap<ThreadId, string>,
): NotificationThread[] =>
  threads.filter((thread) => !isDoneOnGitHub(thread) && !isDoneLocally(thread, doneRecords));

export const readSubjectNumber = (subjectUrl: string | null): number | null => {
  const match = /\/(?:pulls|issues|discussions)\/(\d+)$/.exec(subjectUrl ?? '');

  return match?.[1] === undefined ? null : Number(match[1]);
};

const readSubjectSha = (subjectUrl: string | null): string | null =>
  /\/commits\/([0-9a-f]+)$/i.exec(subjectUrl ?? '')?.[1] ?? null;

export const pageOfThread = (thread: NotificationThread): BrowserPage => {
  const { repository, subjectType, subjectUrl } = thread;
  const repo: BrowserPage = { kind: 'repo', repository };

  if (subjectType === 'PullRequest' || subjectType === 'Issue') {
    const number = readSubjectNumber(subjectUrl);

    return number === null ? repo : { kind: 'item', repository, number };
  }

  if (subjectType === 'Commit') {
    const sha = readSubjectSha(subjectUrl);

    return sha === null ? repo : { kind: 'commit', repository, sha };
  }

  if (subjectType === 'Release') {
    return { kind: 'releases', repository };
  }

  return subjectType === 'CheckSuite' ? { kind: 'actions', repository } : repo;
};

export const pagesOfRow = (row: TreeRow): BrowserPage[] => {
  if (row.kind === 'thread') {
    return [pageOfThread(row.thread)];
  }

  return listedRepositories(row.threads).map((repository) => ({ kind: 'repo', repository }));
};
