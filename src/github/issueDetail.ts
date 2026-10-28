import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  IssueComment,
  IssueCommentPage,
  IssueDetailRead,
  IssueId,
  IssueOverview,
  IssueSubject,
} from '../work/work.ts';
import { toIssueCommentId, toIssueId, toViewerId, toViewerLogin } from '../work/work.ts';
import type {
  GhResponse,
  GitHubEffects,
  GitHubFailure,
  GitHubResult,
  GraphqlError,
  GraphqlVariables,
} from './ghApi.ts';
import {
  globalNodeIdHeader,
  graphqlErrorSchema,
  readGraphqlFailure,
  requestGraphql,
} from './ghApi.ts';

interface RepositoryIssueCoordinates {
  owner: string;
  name: string;
  number: number;
}

export interface IssueDetailRequest {
  coordinates: RepositoryIssueCoordinates | { subjectId: IssueId };
  commentsAfter: string | null;
  pageSize: number;
}

type IssueDetailCoordinates = IssueDetailRequest['coordinates'];

interface DigestedRevision {
  body: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
}

type IssueLookup = { kind: 'issue'; issue: IssueSource } | { kind: 'unavailable' | 'unsupported' };

const notFoundType = 'NOT_FOUND';

const isFailedError = (error: GraphqlError): boolean => error.type !== notFoundType;

const invalid = (message: string): { ok: false; failure: GitHubFailure } => ({
  ok: false,
  failure: { kind: 'invalidResponse', message },
});

const digestRevision = (revision: DigestedRevision): string => {
  const content = JSON.stringify([
    revision.body,
    revision.createdAt,
    revision.updatedAt,
    revision.lastEditedAt,
  ]);

  return `v1:${createHash('sha256').update(content).digest('hex')}`;
};

const presentNodes = <T>(nodes: (T | null)[]): T[] =>
  nodes.filter((node): node is T => node !== null);

const overviewFields = [
  'id number url title body state',
  'author { login }',
  'createdAt updatedAt lastEditedAt',
  'labels(first: 10) { totalCount nodes { name } }',
  'assignees(first: 10) { totalCount nodes { login } }',
].join(' ');

const commentFields = 'id author { login } body createdAt updatedAt lastEditedAt url';

const commentsSelection = (hasCursor: boolean): string => {
  const after = hasCursor ? ', after: $after' : '';

  return `comments(first: $pageSize${after}, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount pageInfo { hasNextPage endCursor } nodes { ${commentFields} } }`;
};

const issueSelection = (hasCursor: boolean): string =>
  `${overviewFields} ${commentsSelection(hasCursor)}`;

const isSubjectCoordinates = (
  coordinates: IssueDetailCoordinates,
): coordinates is { subjectId: IssueId } => 'subjectId' in coordinates;

const buildQuery = (coordinates: IssueDetailCoordinates, hasCursor: boolean): string => {
  const cursorDeclaration = hasCursor ? ', $after: String!' : '';

  if (isSubjectCoordinates(coordinates)) {
    return `query($id: ID!, $pageSize: Int!${cursorDeclaration}) { viewer { id login } node(id: $id) { typeName: __typename ... on Issue { ${issueSelection(hasCursor)} } } }`;
  }

  return `query($owner: String!, $name: String!, $number: Int!, $pageSize: Int!${cursorDeclaration}) { viewer { id login } repository(owner: $owner, name: $name) { issue(number: $number) { ${issueSelection(hasCursor)} } } }`;
};

const buildVariables = (request: IssueDetailRequest): GraphqlVariables => {
  const { coordinates, commentsAfter, pageSize } = request;
  const strings: Record<string, string> = {};
  const integers: Record<string, number> = { pageSize };

  if (commentsAfter !== null) {
    strings['after'] = commentsAfter;
  }

  if (isSubjectCoordinates(coordinates)) {
    strings['id'] = coordinates.subjectId;

    return { strings, integers };
  }

  strings['owner'] = coordinates.owner;
  strings['name'] = coordinates.name;
  integers['number'] = coordinates.number;

  return { strings, integers };
};

const viewerSchema = z.object({ id: z.string().min(1), login: z.string().min(1) });

const loginSchema = z.object({ login: z.string() }).nullable();

const revisionSchema = z.object({
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastEditedAt: z.string().nullable(),
});

const commentNodeSchema = revisionSchema.extend({
  id: z.string().min(1),
  author: loginSchema,
  url: z.string(),
});

const issueSchema = revisionSchema.extend({
  id: z.string().min(1),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  author: loginSchema,
  labels: z.object({
    totalCount: z.number().int(),
    nodes: z.array(z.object({ name: z.string() }).nullable()),
  }),
  assignees: z.object({
    totalCount: z.number().int(),
    nodes: z.array(loginSchema),
  }),
  comments: z.object({
    totalCount: z.number().int(),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(commentNodeSchema.nullable()),
  }),
});

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(graphqlErrorSchema).optional(),
});

// A node that is not an Issue has no Issue fields, so only its type name is checked here.
const dataSchema = z
  .object({
    viewer: viewerSchema,
    repository: z.object({ issue: issueSchema.nullable() }).nullable().optional(),
    node: z.looseObject({ typeName: z.string() }).nullable().optional(),
  })
  .nullable();

type ResponseData = NonNullable<z.infer<typeof dataSchema>>;

type IssueSource = z.infer<typeof issueSchema>;

type CommentNode = z.infer<typeof commentNodeSchema>;

const lookUpNodeIssue = (node: ResponseData['node']): GitHubResult<IssueLookup> => {
  if (node === null || node === undefined) {
    return { ok: true, value: { kind: 'unavailable' } };
  }

  if (node.typeName !== 'Issue') {
    return { ok: true, value: { kind: 'unsupported' } };
  }

  const parsed = issueSchema.safeParse(node);

  if (!parsed.success) {
    return invalid(parsed.error.message);
  }

  return { ok: true, value: { kind: 'issue', issue: parsed.data } };
};

const readErrorsFailure = (errors: GraphqlError[], response: GhResponse): GitHubFailure | null => {
  const failures = errors.filter(isFailedError).map((error) => readGraphqlFailure(error, response));

  return failures.find((failure) => failure.kind === 'rateLimited') ?? failures[0] ?? null;
};

const lookUpIssue = (
  coordinates: IssueDetailCoordinates,
  data: ResponseData,
): GitHubResult<IssueLookup> => {
  if (isSubjectCoordinates(coordinates)) {
    return lookUpNodeIssue(data.node);
  }

  const issue = data.repository?.issue ?? null;

  if (issue === null) {
    return { ok: true, value: { kind: 'unavailable' } };
  }

  return { ok: true, value: { kind: 'issue', issue } };
};

const stateByGraphql = { OPEN: 'open', CLOSED: 'closed' } as const;

const readOverview = (issue: IssueSource): IssueOverview => ({
  id: toIssueId(issue.id),
  number: issue.number,
  url: issue.url,
  title: issue.title,
  body: issue.body,
  state: stateByGraphql[issue.state],
  author: issue.author?.login ?? null,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  lastEditedAt: issue.lastEditedAt,
  labels: {
    names: presentNodes(issue.labels.nodes).map((label) => label.name),
    totalCount: issue.labels.totalCount,
  },
  assignees: {
    logins: presentNodes(issue.assignees.nodes).map((assignee) => assignee.login),
    totalCount: issue.assignees.totalCount,
  },
  digest: digestRevision(issue),
});

const readSubject = (overview: IssueOverview): IssueSubject => ({
  id: overview.id,
  number: overview.number,
  url: overview.url,
});

const readComment = (comment: CommentNode): IssueComment => ({
  id: toIssueCommentId(comment.id),
  author: comment.author?.login ?? null,
  body: comment.body,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  lastEditedAt: comment.lastEditedAt,
  url: comment.url,
  digest: digestRevision(comment),
});

const readCommentPage = (comments: IssueSource['comments']): IssueCommentPage => ({
  records: presentNodes(comments.nodes).map(readComment),
  totalCount: comments.totalCount,
  hasNextPage: comments.pageInfo.hasNextPage,
  endCursor: comments.pageInfo.endCursor,
});

export const readIssueDetail = async (
  effects: GitHubEffects,
  request: IssueDetailRequest,
  signal: AbortSignal,
): Promise<GitHubResult<IssueDetailRead>> => {
  const query = buildQuery(request.coordinates, request.commentsAfter !== null);
  const variables = buildVariables(request);
  const response = await requestGraphql(effects, query, variables, signal, [globalNodeIdHeader]);

  if (!response.ok) {
    return response;
  }

  const envelope = envelopeSchema.safeParse(response.value.body);

  if (!envelope.success) {
    return invalid(envelope.error.message);
  }

  const errorsFailure = readErrorsFailure(envelope.data.errors ?? [], response.value);

  if (errorsFailure !== null) {
    return { ok: false, failure: errorsFailure };
  }

  const parsed = dataSchema.safeParse(envelope.data.data);

  if (!parsed.success) {
    return invalid(parsed.error.message);
  }

  const data = parsed.data;

  if (data === null) {
    return invalid('The response has no data');
  }

  const lookup = lookUpIssue(request.coordinates, data);

  if (!lookup.ok) {
    return lookup;
  }

  const viewer = { id: toViewerId(data.viewer.id), login: toViewerLogin(data.viewer.login) };

  if (lookup.value.kind !== 'issue') {
    return { ok: true, value: { kind: lookup.value.kind, viewer } };
  }

  const overview = readOverview(lookup.value.issue);

  return {
    ok: true,
    value: {
      kind: 'issue',
      viewer,
      subject: readSubject(overview),
      overview,
      comments: readCommentPage(lookup.value.issue.comments),
    },
  };
};
