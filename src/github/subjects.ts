import { z } from 'zod';

import type { NotificationThread, SubjectFacts, ThreadId } from '../work/work.ts';
import type { GitHubEffects } from './ghApi.ts';
import { requestGraphql } from './ghApi.ts';

export interface SubjectLookup {
  threadId: ThreadId;
  updatedAt: string;
  facts: SubjectFacts | null;
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

const sharedTimelineFragments = [
  `... on IssueComment { ${authorFields} }`,
  `... on ClosedEvent { ${actorFields} }`,
  `... on ReopenedEvent { ${actorFields} }`,
];

const pullRequestTimelineFragments = [
  ...sharedTimelineFragments,
  `... on PullRequestReview { ${authorFields} }`,
  '... on PullRequestCommit { commit { author { user { login } } } }',
  `... on MergedEvent { ${actorFields} }`,
  `... on HeadRefForcePushedEvent { ${actorFields} }`,
  `... on HeadRefDeletedEvent { ${actorFields} }`,
];

// Without itemTypes, the last item can be a type the fragments skip, such as a cross-reference,
// which does not move the thread's updated_at. Keep each list in step with its fragments.
const sharedItemTypes = ['ISSUE_COMMENT', 'CLOSED_EVENT', 'REOPENED_EVENT'];

const pullRequestItemTypes = [
  ...sharedItemTypes,
  'PULL_REQUEST_REVIEW',
  'PULL_REQUEST_COMMIT',
  'MERGED_EVENT',
  'HEAD_REF_FORCE_PUSHED_EVENT',
  'HEAD_REF_DELETED_EVENT',
];

const selections: Record<SubjectKind, string> = {
  pullRequest: `pullRequest(number: $number) { state ${subjectAuthorFields} timelineItems(last: 1, itemTypes: [${pullRequestItemTypes.join(', ')}]) { nodes { ${pullRequestTimelineFragments.join(' ')} } } }`,
  issue: `issue(number: $number) { state ${subjectAuthorFields} timelineItems(last: 1, itemTypes: [${sharedItemTypes.join(', ')}]) { nodes { ${sharedTimelineFragments.join(' ')} } } }`,
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
  data: z.record(z.string(), repositorySchema.optional()),
  errors: z
    .array(
      z.object({
        type: z.string().optional(),
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

const readFacts = (
  repository: z.infer<typeof repositorySchema> | undefined,
  kind: SubjectKind,
): SubjectFacts | null => {
  const subject = repository?.[kind];

  if (subject === undefined || subject === null) {
    return null;
  }

  return {
    state: stateByGraphql[subject.state],
    author: readAuthor(subject),
    latestActor: readLatestActor(subject),
  };
};

const lookUpBatch = async (
  effects: GitHubEffects,
  batch: SubjectRequest[],
  signal: AbortSignal,
): Promise<SubjectLookup[]> => {
  const { query, variables } = buildBatchQuery(batch);
  const response = await requestGraphql(effects, query, variables, signal);

  if (!response.ok) {
    return [];
  }

  const parsed = responseSchema.safeParse(response.value.body);

  if (!parsed.success) {
    return [];
  }

  const errors = parsed.data.errors ?? [];
  const failedAliases = new Set(errors.map((error) => error.path?.[0]));

  // Only a missing subject is a lasting answer. Other alias errors can be temporary, so those
  // threads get no entry and the next refresh asks again.
  const retryAliases = new Set(
    errors.filter((error) => error.type !== 'NOT_FOUND').map((error) => error.path?.[0]),
  );

  return batch.flatMap((request, index) => {
    const alias = `t${index}`;

    if (retryAliases.has(alias)) {
      return [];
    }

    const facts = failedAliases.has(alias)
      ? null
      : readFacts(parsed.data.data[alias], request.kind);

    return [{ threadId: request.thread.id, updatedAt: request.thread.updatedAt, facts }];
  });
};

export const lookUpSubjects = async (
  effects: GitHubEffects,
  threads: NotificationThread[],
  signal: AbortSignal,
): Promise<SubjectLookup[]> => {
  const requests = threads.map(readSubjectRequest).filter((request) => request !== null);

  const batches = await Promise.all(
    chunk(requests).map((batch) => lookUpBatch(effects, batch, signal)),
  );

  return batches.flat();
};
