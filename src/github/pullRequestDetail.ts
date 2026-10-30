import { z } from 'zod';

import type { PullRequestDetailRead, PullRequestId } from '../work/work.ts';
import { toViewerId, toViewerLogin } from '../work/work.ts';
import type { GitHubEffects, GitHubResult, GraphqlVariables } from './ghApi.ts';
import {
  globalNodeIdHeader,
  invalid,
  readGraphqlData,
  requestGraphql,
  viewerSchema,
} from './ghApi.ts';
import { readPullRequestSource } from './pullRequestDetailSources.ts';

interface RepositoryPullRequestCoordinates {
  owner: string;
  name: string;
  number: number;
}

type PullRequestCoordinates = RepositoryPullRequestCoordinates | { subjectId: PullRequestId };

type PullRequestSourceRequest =
  | { source: 'overview' }
  | { source: 'commits' | 'checks' | 'files'; after: string | null };

export type PullRequestDetailRequest = {
  coordinates: PullRequestCoordinates;
  pageSize: number;
} & PullRequestSourceRequest;

type PullRequestLookup =
  | { kind: 'pullRequest'; raw: unknown }
  | { kind: 'unavailable' | 'unsupported' };

const headerFields = 'id headRefOid baseRefOid';

const overviewFields = [
  'number url title body state isDraft createdAt updatedAt lastEditedAt',
  'author { login }',
  'baseRefName headRefName',
  'labels(first: 10) { totalCount nodes { name } }',
  'assignees(first: 10) { totalCount nodes { login } }',
  'reviewRequests(first: 10) { totalCount nodes { requestedReviewer { typeName: __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name } } } }',
  'reviewDecision mergeable mergeStateStatus checksUrl',
].join(' ');

const pageInfoFields = 'pageInfo { hasNextPage endCursor }';

const isSubjectCoordinates = (
  coordinates: PullRequestCoordinates,
): coordinates is { subjectId: PullRequestId } => 'subjectId' in coordinates;

const readCursor = (request: PullRequestDetailRequest): string | null =>
  request.source === 'overview' ? null : request.after;

const selectionsBySource = (after: string): Record<PullRequestDetailRequest['source'], string> => ({
  overview: overviewFields,
  commits: `commits(first: $pageSize${after}) { totalCount ${pageInfoFields} nodes { commit { oid messageHeadline authoredDate url author { name user { login } } } } }`,
  checks: `commits(last: 1) { nodes { commit { statusCheckRollup { state commit { oid } contexts(first: $pageSize${after}) { totalCount ${pageInfoFields} nodes { typeName: __typename ... on CheckRun { name status conclusion detailsUrl url databaseId } ... on StatusContext { context state description targetUrl } } } } } } }`,
  files: `changedFiles additions deletions files(first: $pageSize${after}) { totalCount ${pageInfoFields} nodes { path changeType additions deletions } }`,
});

const sourceSelection = (request: PullRequestDetailRequest): string => {
  const cursor = readCursor(request);
  const after = cursor === null ? '' : ', after: $after';

  return selectionsBySource(after)[request.source];
};

const declarationsOf = (request: PullRequestDetailRequest): string[] => {
  const coordinateDeclarations = isSubjectCoordinates(request.coordinates)
    ? ['$id: ID!']
    : ['$owner: String!', '$name: String!', '$number: Int!'];

  if (request.source === 'overview') {
    return coordinateDeclarations;
  }

  const cursor = readCursor(request);
  const cursorDeclarations = cursor === null ? [] : ['$after: String!'];

  return [...coordinateDeclarations, '$pageSize: Int!', ...cursorDeclarations];
};

const buildQuery = (request: PullRequestDetailRequest): string => {
  const declarations = declarationsOf(request).join(', ');
  const selection = `${headerFields} ${sourceSelection(request)}`;

  if (isSubjectCoordinates(request.coordinates)) {
    return `query(${declarations}) { viewer { id login } node(id: $id) { typeName: __typename ... on PullRequest { ${selection} } } }`;
  }

  return `query(${declarations}) { viewer { id login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${selection} } } }`;
};

const buildVariables = (request: PullRequestDetailRequest): GraphqlVariables => {
  const strings: Record<string, string> = {};
  const integers: Record<string, number> = {};

  if (request.source !== 'overview') {
    integers['pageSize'] = request.pageSize;
  }

  const cursor = readCursor(request);

  if (cursor !== null) {
    strings['after'] = cursor;
  }

  if (isSubjectCoordinates(request.coordinates)) {
    strings['id'] = request.coordinates.subjectId;

    return { strings, integers };
  }

  strings['owner'] = request.coordinates.owner;
  strings['name'] = request.coordinates.name;
  integers['number'] = request.coordinates.number;

  return { strings, integers };
};

const dataSchema = z
  .object({
    viewer: viewerSchema,
    repository: z.object({ pullRequest: z.unknown() }).nullable().optional(),
    node: z.looseObject({ typeName: z.string() }).nullable().optional(),
  })
  .nullable();

type DataSource = NonNullable<z.infer<typeof dataSchema>>;

const lookUpNodePullRequest = (node: DataSource['node']): PullRequestLookup => {
  if (node === null || node === undefined) {
    return { kind: 'unavailable' };
  }

  if (node.typeName !== 'PullRequest') {
    return { kind: 'unsupported' };
  }

  return { kind: 'pullRequest', raw: node };
};

const lookUpPullRequest = (
  coordinates: PullRequestCoordinates,
  data: DataSource,
): PullRequestLookup => {
  if (isSubjectCoordinates(coordinates)) {
    return lookUpNodePullRequest(data.node);
  }

  const pullRequest = data.repository?.pullRequest ?? null;

  if (pullRequest === null) {
    return { kind: 'unavailable' };
  }

  return { kind: 'pullRequest', raw: pullRequest };
};

export const readPullRequestDetail = async (
  effects: GitHubEffects,
  request: PullRequestDetailRequest,
  signal: AbortSignal,
): Promise<GitHubResult<PullRequestDetailRead>> => {
  const query = buildQuery(request);
  const variables = buildVariables(request);
  const response = await requestGraphql(effects, query, variables, signal, [globalNodeIdHeader]);

  if (!response.ok) {
    return response;
  }

  const envelope = readGraphqlData(response.value);

  if (!envelope.ok) {
    return envelope;
  }

  const parsed = dataSchema.safeParse(envelope.value);

  if (!parsed.success) {
    return invalid(parsed.error.message);
  }

  const data = parsed.data;

  if (data === null) {
    return invalid('The response has no data');
  }

  const viewer = { id: toViewerId(data.viewer.id), login: toViewerLogin(data.viewer.login) };
  const lookup = lookUpPullRequest(request.coordinates, data);

  if (lookup.kind !== 'pullRequest') {
    return { ok: true, value: { kind: lookup.kind, viewer } };
  }

  return readPullRequestSource(request.source, viewer, lookup.raw);
};
