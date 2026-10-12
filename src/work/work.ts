import { invariant } from '../invariant.ts';

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

export const selectOpenThreads = (threads: NotificationThread[]): NotificationThread[] =>
  threads.filter((thread) => !isDoneOnGitHub(thread));

export const readSubjectNumber = (subjectUrl: string | null): number | null => {
  const match = /\/(?:pulls|issues|discussions)\/(\d+)$/.exec(subjectUrl ?? '');

  return match?.[1] === undefined ? null : Number(match[1]);
};
