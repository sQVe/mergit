import type { NotificationThread } from './work.ts';

export interface TreeNode {
  key: string;
  title: string;
  kind: 'group' | 'repo';
  /** Every thread under this node, newest first. */
  threads: NotificationThread[];
  /** Repo nodes for a group node. Empty for a repo node. */
  children: TreeNode[];
}

export interface NodeRow {
  kind: 'node';
  key: string;
  nodeKey: string;
  title: string;
  depth: number;
  topLevel: boolean;
  folded: boolean;
  threads: NotificationThread[];
}

export interface ThreadRow {
  kind: 'thread';
  key: string;
  thread: NotificationThread;
  depth: number;
  nodeRowKey: string;
  last: boolean;
}

export type TreeRow = NodeRow | ThreadRow;

interface Bucket {
  key: string;
  title: string;
  matches: (thread: NotificationThread) => boolean;
}

export const groupings = ['reason', 'repo', 'type', 'none'] as const;

export type Grouping = (typeof groupings)[number];

const reasonBuckets: Bucket[] = [
  {
    key: 'review',
    title: 'Review requested',
    matches: (thread) => thread.reason === 'review_requested',
  },
  {
    key: 'mention',
    title: 'Mention',
    matches: (thread) => thread.reason === 'mention' || thread.reason === 'team_mention',
  },
  { key: 'assigned', title: 'Assigned', matches: (thread) => thread.reason === 'assign' },
  { key: 'author', title: 'Author', matches: (thread) => thread.reason === 'author' },
  { key: 'comment', title: 'Comment', matches: (thread) => thread.reason === 'comment' },
  { key: 'state', title: 'State change', matches: (thread) => thread.reason === 'state_change' },
  {
    key: 'subscribed',
    title: 'Subscribed or manual',
    matches: (thread) => thread.reason === 'subscribed' || thread.reason === 'manual',
  },
  { key: 'ci', title: 'CI activity', matches: (thread) => thread.reason === 'ci_activity' },
];

const typeBuckets: Bucket[] = [
  {
    key: 'pull-requests',
    title: 'Pull requests',
    matches: (thread) => thread.subjectType === 'PullRequest',
  },
  { key: 'issues', title: 'Issues', matches: (thread) => thread.subjectType === 'Issue' },
  { key: 'ci-runs', title: 'CI runs', matches: (thread) => thread.subjectType === 'CheckSuite' },
  { key: 'releases', title: 'Releases', matches: (thread) => thread.subjectType === 'Release' },
];

const isRelease = (thread: NotificationThread): boolean => thread.subjectType === 'Release';

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
};

const newestUpdate = (node: TreeNode): string =>
  node.threads.reduce(
    (newest, thread) => (thread.updatedAt > newest ? thread.updatedAt : newest),
    '',
  );

const sortByCount = (nodes: TreeNode[]): TreeNode[] =>
  nodes.toSorted(
    (left, right) =>
      right.threads.length - left.threads.length || compareText(left.title, right.title),
  );

const sortByNewest = (nodes: TreeNode[]): TreeNode[] =>
  nodes.toSorted(
    (left, right) =>
      compareText(newestUpdate(right), newestUpdate(left)) || compareText(left.title, right.title),
  );

const repoNodes = (threads: NotificationThread[], prefix: string): TreeNode[] => {
  const byRepo = new Map<string, NotificationThread[]>();

  for (const thread of threads) {
    const existing = byRepo.get(thread.repository);

    if (existing === undefined) {
      byRepo.set(thread.repository, [thread]);
    } else {
      existing.push(thread);
    }
  }

  return [...byRepo].map(([repository, repoThreads]) => ({
    key: `${prefix}${repository}`,
    title: repository,
    kind: 'repo',
    threads: repoThreads,
    children: [],
  }));
};

const groupNodes = (
  threads: NotificationThread[],
  buckets: Bucket[],
  fallback: Bucket,
  isForced: (thread: NotificationThread) => Bucket | undefined,
): TreeNode[] => {
  const members = new Map<Bucket, NotificationThread[]>();

  for (const thread of threads) {
    const bucket =
      isForced(thread) ?? buckets.find((candidate) => candidate.matches(thread)) ?? fallback;

    const existing = members.get(bucket);

    if (existing === undefined) {
      members.set(bucket, [thread]);
    } else {
      existing.push(thread);
    }
  }

  const nodes: TreeNode[] = [];

  for (const bucket of [...buckets, fallback]) {
    const bucketThreads = members.get(bucket);

    if (bucketThreads !== undefined) {
      nodes.push({
        key: bucket.key,
        title: bucket.title,
        kind: 'group',
        threads: bucketThreads,
        children: sortByCount(repoNodes(bucketThreads, `${bucket.key}/`)),
      });
    }
  }

  return nodes;
};

const otherBucket: Bucket = { key: 'other', title: 'Other', matches: () => true };

const releaseBucket: Bucket = { key: 'release', title: 'Release', matches: isRelease };

export const buildTree = (threads: NotificationThread[], grouping: Grouping): TreeNode[] => {
  if (grouping === 'reason') {
    return groupNodes(threads, [...reasonBuckets, releaseBucket], otherBucket, (thread) =>
      isRelease(thread) ? releaseBucket : undefined,
    );
  }

  if (grouping === 'type') {
    return groupNodes(threads, typeBuckets, otherBucket, () => undefined);
  }

  const repos = repoNodes(threads, '');

  return grouping === 'repo' ? sortByCount(repos) : sortByNewest(repos);
};

const pushNode = (
  rows: TreeRow[],
  node: TreeNode,
  depth: number,
  folded: ReadonlySet<string>,
): void => {
  const isFolded = folded.has(node.key);
  const nodeRowKey = `node:${node.key}`;

  rows.push({
    kind: 'node',
    key: nodeRowKey,
    nodeKey: node.key,
    title: node.title,
    depth,
    topLevel: depth === 0,
    folded: isFolded,
    threads: node.threads,
  });

  if (isFolded) {
    return;
  }

  for (const child of node.children) {
    pushNode(rows, child, depth + 1, folded);
  }

  if (node.kind === 'repo') {
    node.threads.forEach((thread, index) => {
      rows.push({
        kind: 'thread',
        key: `thread:${thread.id}`,
        thread,
        depth: depth + 1,
        nodeRowKey,
        last: index === node.threads.length - 1,
      });
    });
  }
};

export const flattenTree = (tree: TreeNode[], folded: ReadonlySet<string>): TreeRow[] => {
  const rows: TreeRow[] = [];

  for (const node of tree) {
    pushNode(rows, node, 0, folded);
  }

  return rows;
};
