import { z } from 'zod';

import type {
  DetailViewer,
  PullRequestCheck,
  PullRequestCheckRollup,
  PullRequestCommit,
  PullRequestDetailRead,
  PullRequestFile,
  PullRequestOverview,
  PullRequestPage,
  PullRequestRef,
  PullRequestReviewer,
} from '../work/work.ts';
import { toPullRequestId } from '../work/work.ts';
import type { GitHubResult } from './ghApi.ts';
import { invalid, presentNodes } from './ghApi.ts';
import { digestRevision } from './issueDetail.ts';

type PullRequestSource = 'overview' | 'commits' | 'checks' | 'files';

const loginSchema = z.object({ login: z.string() }).nullable();

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

const connectionSchema = <TNode extends z.ZodType>(node: TNode) =>
  z.object({
    totalCount: z.number().int(),
    pageInfo: pageInfoSchema,
    nodes: z.array(node.nullable()),
  });

const headerSchema = z.object({
  id: z.string().min(1),
  headRefOid: z.string().min(1),
  baseRefOid: z.string().min(1),
});

const reviewerSchema = z.union([
  z.object({ typeName: z.enum(['User', 'Bot', 'Mannequin']), login: z.string() }),
  z.object({ typeName: z.literal('Team'), name: z.string() }),
  z.object({ typeName: z.string() }),
]);

const overviewSchema = headerSchema.extend({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  author: loginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastEditedAt: z.string().nullable(),
  baseRefName: z.string(),
  headRefName: z.string(),
  labels: z.object({
    totalCount: z.number().int(),
    nodes: z.array(z.object({ name: z.string() }).nullable()),
  }),
  assignees: z.object({
    totalCount: z.number().int(),
    nodes: z.array(loginSchema),
  }),
  reviewRequests: z.object({
    totalCount: z.number().int(),
    nodes: z.array(z.object({ requestedReviewer: reviewerSchema.nullable() }).nullable()),
  }),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).nullable(),
  mergeStateStatus: z
    .enum(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'])
    .nullable(),
  checksUrl: z.string(),
});

const commitNodeSchema = z.object({
  commit: z.object({
    oid: z.string(),
    messageHeadline: z.string(),
    authoredDate: z.string(),
    url: z.string(),
    author: z.object({ name: z.string().nullable(), user: loginSchema }).nullable(),
  }),
});

const commitsSchema = headerSchema.extend({
  commits: connectionSchema(commitNodeSchema),
});

const checkNodeSchema = z.discriminatedUnion('typeName', [
  z.object({
    typeName: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    url: z.string(),
    databaseId: z.number().int().nullable(),
  }),
  z.object({
    typeName: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
    description: z.string().nullable(),
    targetUrl: z.string().nullable(),
  }),
]);

const rollupSchema = z.object({
  state: z.string(),
  commit: z.object({ oid: z.string() }),
  contexts: connectionSchema(checkNodeSchema),
});

const checksSchema = headerSchema.extend({
  commits: z.object({
    nodes: z.array(
      z.object({ commit: z.object({ statusCheckRollup: rollupSchema.nullable() }) }).nullable(),
    ),
  }),
});

const fileNodeSchema = z.object({
  path: z.string(),
  changeType: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
});

const filesSchema = headerSchema.extend({
  changedFiles: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  files: connectionSchema(fileNodeSchema).nullable(),
});

type OverviewSource = z.infer<typeof overviewSchema>;

type ReviewerSource = z.infer<typeof reviewerSchema>;

type CommitNodeSource = z.infer<typeof commitNodeSchema>;

type RollupSource = z.infer<typeof rollupSchema>;

type CheckNodeSource = z.infer<typeof checkNodeSchema>;

type ChecksSource = z.infer<typeof checksSchema>;

type FilesSource = z.infer<typeof filesSchema>;

const stateByGraphql = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } as const;

const reviewDecisionByGraphql = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changesRequested',
  REVIEW_REQUIRED: 'reviewRequired',
} as const;

const mergeableByGraphql = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
} as const;

const mergeStateStatusByGraphql = {
  BEHIND: 'behind',
  BLOCKED: 'blocked',
  CLEAN: 'clean',
  DIRTY: 'dirty',
  DRAFT: 'draft',
  HAS_HOOKS: 'hasHooks',
  UNKNOWN: 'unknown',
  UNSTABLE: 'unstable',
} as const;

const readRef = (pullRequest: {
  id: string;
  headRefOid: string;
  baseRefOid: string;
}): PullRequestRef => ({
  id: toPullRequestId(pullRequest.id),
  headOid: pullRequest.headRefOid,
  baseOid: pullRequest.baseRefOid,
});

const readPage = <TNode, TRecord>(
  connection: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (TNode | null)[];
  },
  readRecord: (node: TNode) => TRecord,
): PullRequestPage<TRecord> => ({
  records: presentNodes(connection.nodes).map(readRecord),
  totalCount: connection.totalCount,
  hasNextPage: connection.pageInfo.hasNextPage,
  endCursor: connection.pageInfo.endCursor,
});

const readReviewer = (reviewer: ReviewerSource): PullRequestReviewer => {
  if ('login' in reviewer) {
    return { kind: 'account', typeName: reviewer.typeName, login: reviewer.login };
  }

  if ('name' in reviewer) {
    return { kind: 'team', name: reviewer.name };
  }

  return { kind: 'other', typeName: reviewer.typeName };
};

const readReviewRequests = (
  reviewRequests: OverviewSource['reviewRequests'],
): PullRequestOverview['reviewRequests'] => {
  const reviewers = presentNodes(reviewRequests.nodes).map((node) => node.requestedReviewer);

  return {
    reviewers: presentNodes(reviewers).map(readReviewer),
    totalCount: reviewRequests.totalCount,
  };
};

const readReviewDecision = (
  value: OverviewSource['reviewDecision'],
): PullRequestOverview['reviewDecision'] =>
  value === null ? null : reviewDecisionByGraphql[value];

const readOverviewFields = (pullRequest: OverviewSource): PullRequestOverview => ({
  number: pullRequest.number,
  url: pullRequest.url,
  title: pullRequest.title,
  body: pullRequest.body,
  state: stateByGraphql[pullRequest.state],
  isDraft: pullRequest.isDraft,
  author: pullRequest.author?.login ?? null,
  createdAt: pullRequest.createdAt,
  updatedAt: pullRequest.updatedAt,
  lastEditedAt: pullRequest.lastEditedAt,
  base: { refName: pullRequest.baseRefName, oid: pullRequest.baseRefOid },
  head: { refName: pullRequest.headRefName, oid: pullRequest.headRefOid },
  labels: {
    names: presentNodes(pullRequest.labels.nodes).map((label) => label.name),
    totalCount: pullRequest.labels.totalCount,
  },
  assignees: {
    logins: presentNodes(pullRequest.assignees.nodes).map((assignee) => assignee.login),
    totalCount: pullRequest.assignees.totalCount,
  },
  reviewRequests: readReviewRequests(pullRequest.reviewRequests),
  reviewDecision: readReviewDecision(pullRequest.reviewDecision),
  mergeable: mergeableByGraphql[pullRequest.mergeable ?? 'UNKNOWN'],
  mergeStateStatus: mergeStateStatusByGraphql[pullRequest.mergeStateStatus ?? 'UNKNOWN'],
  checksUrl: pullRequest.checksUrl,
  digest: digestRevision(pullRequest),
});

const readOverview = (
  viewer: DetailViewer,
  pullRequest: OverviewSource,
): PullRequestDetailRead => ({
  kind: 'overview',
  viewer,
  pullRequest: readRef(pullRequest),
  overview: readOverviewFields(pullRequest),
});

const readCommitAuthor = (author: CommitNodeSource['commit']['author']): string | null =>
  author?.user?.login ?? author?.name ?? null;

const readCommit = (node: CommitNodeSource): PullRequestCommit => ({
  oid: node.commit.oid,
  headline: node.commit.messageHeadline,
  author: readCommitAuthor(node.commit.author),
  authoredDate: node.commit.authoredDate,
  url: node.commit.url,
});

const readCommits = (
  viewer: DetailViewer,
  pullRequest: z.infer<typeof commitsSchema>,
): PullRequestDetailRead => ({
  kind: 'commits',
  viewer,
  pullRequest: readRef(pullRequest),
  commits: readPage(pullRequest.commits, readCommit),
});

const readCheck = (node: CheckNodeSource): PullRequestCheck => {
  if (node.typeName === 'CheckRun') {
    return {
      kind: 'checkRun',
      name: node.name,
      status: node.status,
      conclusion: node.conclusion,
      detailsUrl: node.detailsUrl,
      url: node.url,
      databaseId: node.databaseId,
    };
  }

  return {
    kind: 'statusContext',
    context: node.context,
    state: node.state,
    description: node.description,
    targetUrl: node.targetUrl,
  };
};

const readRollup = (rollup: RollupSource): PullRequestCheckRollup => ({
  state: rollup.state,
  commitOid: rollup.commit.oid,
  checks: readPage(rollup.contexts, readCheck),
});

const readHeadRollup = (commits: ChecksSource['commits']): RollupSource | null =>
  presentNodes(commits.nodes)[0]?.commit.statusCheckRollup ?? null;

const readChecks = (viewer: DetailViewer, pullRequest: ChecksSource): PullRequestDetailRead => {
  const headRollup = readHeadRollup(pullRequest.commits);
  const rollup = headRollup === null ? null : readRollup(headRollup);

  return { kind: 'checks', viewer, pullRequest: readRef(pullRequest), rollup };
};

const readFile = (node: z.infer<typeof fileNodeSchema>): PullRequestFile => ({
  path: node.path,
  changeType: node.changeType,
  additions: node.additions,
  deletions: node.deletions,
});

const readFiles = (viewer: DetailViewer, pullRequest: FilesSource): PullRequestDetailRead => {
  const files = pullRequest.files === null ? null : readPage(pullRequest.files, readFile);

  return {
    kind: 'files',
    viewer,
    pullRequest: readRef(pullRequest),
    totals: {
      changedFiles: pullRequest.changedFiles,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
    },
    files,
  };
};

const readWith = <TValue>(
  schema: z.ZodType<TValue>,
  raw: unknown,
  read: (value: TValue) => PullRequestDetailRead,
): GitHubResult<PullRequestDetailRead> => {
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    return invalid(parsed.error.message);
  }

  return { ok: true, value: read(parsed.data) };
};

export const readPullRequestSource = (
  source: PullRequestSource,
  viewer: DetailViewer,
  raw: unknown,
): GitHubResult<PullRequestDetailRead> => {
  if (source === 'overview') {
    return readWith(overviewSchema, raw, (pullRequest) => readOverview(viewer, pullRequest));
  }

  if (source === 'commits') {
    return readWith(commitsSchema, raw, (pullRequest) => readCommits(viewer, pullRequest));
  }

  if (source === 'checks') {
    return readWith(checksSchema, raw, (pullRequest) => readChecks(viewer, pullRequest));
  }

  return readWith(filesSchema, raw, (pullRequest) => readFiles(viewer, pullRequest));
};
