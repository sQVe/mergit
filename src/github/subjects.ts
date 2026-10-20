import { z } from 'zod';

import type { NotificationThread, SubjectFacts, ThreadId } from '../work/work.ts';
import type { GhResponse, GitHubEffects, GitHubFailure } from './ghApi.ts';
import { requestGraphql } from './ghApi.ts';

export interface SubjectLookup {
  threadId: ThreadId;
  updatedAt: string;
  facts: SubjectFacts | null;
}

export interface SubjectLookupResult {
  lookups: SubjectLookup[];
  failures: GitHubFailure[];
}

type SubjectKind = 'pullRequest' | 'issue';

interface SubjectRequest {
  thread: NotificationThread;
  kind: SubjectKind;
  owner: string;
  name: string;
  number: number;
}

const batchSize = 50;

const subjectKinds: Record<string, SubjectKind> = {
  PullRequest: 'pullRequest',
  Issue: 'issue',
};

const actorFields = 'actor { login }';
const authorFields = 'author { login }';
const subjectAuthorFields = 'author { __typename login }';

// Without itemTypes, the last item can be a type the fragments skip, such as a cross-reference,
// which does not move the thread's updated_at.
const sharedTimelineEvents = {
  ISSUE_COMMENT: `... on IssueComment { ${authorFields} }`,
  CLOSED_EVENT: `... on ClosedEvent { ${actorFields} }`,
  REOPENED_EVENT: `... on ReopenedEvent { ${actorFields} }`,
};

const pullRequestTimelineEvents = {
  ...sharedTimelineEvents,
  PULL_REQUEST_REVIEW: `... on PullRequestReview { ${authorFields} }`,
  PULL_REQUEST_COMMIT: '... on PullRequestCommit { commit { author { user { login } } } }',
  MERGED_EVENT: `... on MergedEvent { ${actorFields} }`,
  HEAD_REF_FORCE_PUSHED_EVENT: `... on HeadRefForcePushedEvent { ${actorFields} }`,
  HEAD_REF_DELETED_EVENT: `... on HeadRefDeletedEvent { ${actorFields} }`,
};

const selectTimeline = (events: Record<string, string>) => {
  const itemTypes = Object.keys(events).join(', ');
  const fragments = Object.values(events).join(' ');

  return `timelineItems(last: 1, itemTypes: [${itemTypes}]) { nodes { ${fragments} } }`;
};

const selections: Record<SubjectKind, string> = {
  pullRequest: `pullRequest(number: $number) { state ${subjectAuthorFields} ${selectTimeline(pullRequestTimelineEvents)} }`,
  issue: `issue(number: $number) { state ${subjectAuthorFields} ${selectTimeline(sharedTimelineEvents)} }`,
};

const readSubjectRequest = (thread: NotificationThread): SubjectRequest | null => {
  const kind = subjectKinds[thread.subjectType];
  const match = /\/repos\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/(\d+)$/.exec(thread.subjectUrl ?? '');

  if (kind === undefined || match === null) {
    return null;
  }

  const [, owner = '', name = '', number = ''] = match;

  return { thread, kind, owner, name, number: Number(number) };
};

const chunk = <T>(items: T[]): T[][] => {
  const chunks: T[][] = [];

  for (let start = 0; start < items.length; start += batchSize) {
    chunks.push(items.slice(start, start + batchSize));
  }

  return chunks;
};

const buildBatchQuery = (batch: SubjectRequest[]) => {
  const declarations: string[] = [];
  const aliases: string[] = [];
  const strings: Record<string, string> = {};
  const integers: Record<string, number> = {};

  for (const [index, request] of batch.entries()) {
    declarations.push(`$o${index}: String!`, `$r${index}: String!`, `$n${index}: Int!`);
    strings[`o${index}`] = request.owner;
    strings[`r${index}`] = request.name;
    integers[`n${index}`] = request.number;

    const selection = selections[request.kind].replace('$number', `$n${index}`);

    aliases.push(`t${index}: repository(owner: $o${index}, name: $r${index}) { ${selection} }`);
  }

  const query = `query(${declarations.join(', ')}) { ${aliases.join(' ')} }`;

  return { query, variables: { strings, integers } };
};

const loginSchema = z.object({ login: z.string() }).nullish();

const subjectAuthorSchema = z
  .object({ __typename: z.string().optional(), login: z.string() })
  .nullish();

const timelineNodeSchema = z.object({
  actor: loginSchema,
  author: loginSchema,
  commit: z.object({ author: z.object({ user: loginSchema }).nullish() }).nullish(),
});

const subjectSchema = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  author: subjectAuthorSchema,
  timelineItems: z.object({ nodes: z.array(timelineNodeSchema.nullable()) }),
});

const repositorySchema = z
  .object({ pullRequest: subjectSchema.nullish(), issue: subjectSchema.nullish() })
  .nullable();

const responseSchema = z.object({
  data: z.record(z.string(), repositorySchema.optional()).nullish(),
  errors: z
    .array(
      z.object({
        type: z.string().optional(),
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});

const stateByGraphql: Record<'OPEN' | 'CLOSED' | 'MERGED', SubjectFacts['state']> = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
};

const readLatestActor = (subject: z.infer<typeof subjectSchema>): string | null => {
  const node = subject.timelineItems.nodes.at(-1);

  if (node === undefined || node === null) {
    return null;
  }

  return node.actor?.login ?? node.author?.login ?? node.commit?.author?.user?.login ?? null;
};

const readAuthor = (subject: z.infer<typeof subjectSchema>): string | null => {
  const { author } = subject;

  if (author === undefined || author === null) {
    return null;
  }

  // oxlint-disable-next-line eslint/no-underscore-dangle -- GraphQL names this field.
  return author.__typename === 'Bot' ? `${author.login}[bot]` : author.login;
};

const readFacts = (subject: z.infer<typeof subjectSchema>): SubjectFacts => ({
  state: stateByGraphql[subject.state],
  author: readAuthor(subject),
  latestActor: readLatestActor(subject),
});

type GraphqlError = NonNullable<z.infer<typeof responseSchema>['errors']>[number];

const rateLimitedType = 'RATE_LIMITED';
const notFoundType = 'NOT_FOUND';
const millisecondsPerSecond = 1000;

const readFailure = (error: GraphqlError, response: GhResponse): GitHubFailure => {
  const reset = Number(response.headers.get('x-ratelimit-reset'));

  if (error.type === rateLimitedType && Number.isFinite(reset)) {
    return { kind: 'rateLimited', resetAt: new Date(reset * millisecondsPerSecond) };
  }

  return {
    kind: 'requestFailed',
    status: response.status,
    message: error.message,
  };
};

const decodeAlias = (
  request: SubjectRequest,
  repository: z.infer<typeof repositorySchema> | undefined,
  hasAliasFailure: boolean,
): SubjectLookup | null => {
  const { thread, kind } = request;
  const subject = repository?.[kind];
  const missing = { threadId: thread.id, updatedAt: thread.updatedAt, facts: null };

  if (hasAliasFailure) {
    return null;
  }

  if (repository === null || subject === null) {
    return missing;
  }

  if (subject === undefined) {
    return null;
  }

  return { threadId: thread.id, updatedAt: thread.updatedAt, facts: readFacts(subject) };
};

const lookUpBatch = async (
  effects: GitHubEffects,
  batch: SubjectRequest[],
  signal: AbortSignal,
): Promise<SubjectLookupResult> => {
  const { query, variables } = buildBatchQuery(batch);
  const response = await requestGraphql(effects, query, variables, signal);

  if (!response.ok) {
    return { lookups: [], failures: [response.failure] };
  }

  const parsed = responseSchema.safeParse(response.value.body);

  if (!parsed.success) {
    const failure: GitHubFailure = { kind: 'invalidResponse', message: parsed.error.message };

    return { lookups: [], failures: [failure] };
  }

  const errors = parsed.data.errors ?? [];
  const data = parsed.data.data ?? {};
  const failedErrors = errors.filter((error) => error.type !== notFoundType);
  const failures = failedErrors.map((error) => readFailure(error, response.value));

  const lookups = batch.flatMap((request, index) => {
    const alias = `t${index}`;
    const hasAliasFailure = failedErrors.some((error) => error.path?.[0] === alias);
    const lookup = decodeAlias(request, data[alias], hasAliasFailure);

    return lookup === null ? [] : [lookup];
  });

  return { lookups, failures };
};

export const lookUpSubjects = async (
  effects: GitHubEffects,
  threads: NotificationThread[],
  signal: AbortSignal,
): Promise<SubjectLookupResult> => {
  const requests = threads.map(readSubjectRequest).filter((request) => request !== null);

  const batches = await Promise.all(
    chunk(requests).map((batch) => lookUpBatch(effects, batch, signal)),
  );

  return {
    lookups: batches.flatMap((batch) => batch.lookups),
    failures: batches.flatMap((batch) => batch.failures),
  };
};
