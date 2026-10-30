import { z } from 'zod';

import type { NotificationThread, ThreadId, ViewerId, ViewerLogin } from '../work/work.ts';
import { toViewerId, toViewerLogin } from '../work/work.ts';
import type { GhResponse, GitHubEffects, GitHubFailure, GitHubResult } from './ghApi.ts';
import { globalNodeIdHeader, requestGh, requestGhDelete } from './ghApi.ts';
import type { NotificationFeed, NotificationPage } from './notifications.ts';
import { findNextPage, notificationPageSchema, readPollInterval } from './notifications.ts';

export { createGhRunner } from './ghApi.ts';
export type { GitHubEffects, GitHubFailure, GitHubResult } from './ghApi.ts';
export { readIssueDetail } from './issueDetail.ts';
export type { IssueDetailRequest } from './issueDetail.ts';
export { readPullRequestDetail } from './pullRequestDetail.ts';
export type { PullRequestDetailRequest } from './pullRequestDetail.ts';
export type { NotificationFeed, NotificationPage } from './notifications.ts';
export { lookUpSubjects } from './subjects.ts';
export type { SubjectLookup, SubjectLookupResult } from './subjects.ts';

interface FetchedPage {
  page: NotificationPage | null;
  response: GhResponse;
  pollInterval: number | null;
}

export interface Viewer {
  id: ViewerId;
  login: ViewerLogin;
  etag: string | null;
}

export interface SavedNotificationPage {
  path: string;
  etag: string | null;
  next: string | null;
  body: string;
}

export interface NotificationFeedRead {
  feed: NotificationFeed;
  threads: NotificationThread[];
  pollInterval: number | null;
}

export type NotificationPoll =
  | { kind: 'unchanged'; pollInterval: number | null }
  | { kind: 'changed'; page: NotificationPage; pollInterval: number | null };

export interface NotificationFeedRequest {
  previous: NotificationFeed | null;
  firstPage?: NotificationPage;
}

export interface NotificationVerification {
  kind: 'stable' | 'changed';
  pollInterval: number | null;
}

const notModifiedStatus = 304;

const viewerSchema = z.object({ login: z.string().min(1), node_id: z.string().min(1) });

const firstNotificationsEndpoint = '/notifications?all=true&per_page=50';

const invalid = (message: string): { ok: false; failure: GitHubFailure } => ({
  ok: false,
  failure: { kind: 'invalidResponse', message },
});

const defaultHost = 'github.com';

const authStatusSchema = z.object({ hosts: z.record(z.string(), z.unknown()) });

const hostsOf = (statusOutput: string): string[] => {
  try {
    const parsed = authStatusSchema.safeParse(JSON.parse(statusOutput));

    return parsed.success ? Object.keys(parsed.data.hosts) : [];
  } catch {
    return [];
  }
};

const readSignedInHosts = async (
  effects: Pick<GitHubEffects, 'runGh'>,
  signal: AbortSignal,
): Promise<string[]> => {
  const run = await effects.runGh(['auth', 'status', '--json', 'hosts'], signal);

  if (run.kind !== 'exited' || run.exitCode !== 0) {
    return [];
  }

  return hostsOf(run.stdout);
};

// gh treats an empty GH_HOST as unset, and without --hostname it uses its only signed-in host.
export const resolveGitHubHost = async (
  effects: Pick<GitHubEffects, 'runGh'>,
  environment: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<string> => {
  const configured = environment['GH_HOST'];

  if (configured !== undefined && configured !== '') {
    return configured;
  }

  const [onlyHost, ...otherHosts] = await readSignedInHosts(effects, signal);

  return onlyHost === undefined || otherHosts.length > 0 ? defaultHost : onlyHost;
};

export const readViewer = async (
  effects: GitHubEffects,
  previous: Viewer | null,
  signal: AbortSignal,
): Promise<GitHubResult<Viewer>> => {
  const response = await requestGh(effects, '/user', signal, previous?.etag ?? null, [
    globalNodeIdHeader,
  ]);

  if (!response.ok) {
    return response;
  }

  if (response.value.status === notModifiedStatus) {
    if (previous === null) {
      return invalid('The viewer was not modified, but none was known');
    }

    return { ok: true, value: previous };
  }

  const parsed = viewerSchema.safeParse(response.value.body);

  if (!parsed.success) {
    return { ok: false, failure: { kind: 'invalidResponse', message: parsed.error.message } };
  }

  return {
    ok: true,
    value: {
      id: toViewerId(parsed.data.node_id),
      login: toViewerLogin(parsed.data.login),
      etag: response.value.headers.get('etag') ?? null,
    },
  };
};

export const markThreadDone = async (
  effects: GitHubEffects,
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<GitHubResult<null>> => {
  const response = await requestGhDelete(effects, `/notifications/threads/${threadId}`, signal);

  if (!response.ok) {
    return response;
  }

  return { ok: true, value: null };
};

const fetchPage = async (
  effects: GitHubEffects,
  endpoint: string,
  etag: string | null,
  signal: AbortSignal,
): Promise<GitHubResult<FetchedPage>> => {
  const response = await requestGh(effects, endpoint, signal, etag);

  if (!response.ok) {
    return response;
  }

  const pollInterval = readPollInterval(response.value.headers);

  if (response.value.status === notModifiedStatus) {
    return { ok: true, value: { page: null, response: response.value, pollInterval } };
  }

  const parsed = notificationPageSchema.safeParse(response.value.body);

  if (!parsed.success) {
    return invalid(parsed.error.message);
  }

  const page: NotificationPage = {
    endpoint,
    etag: response.value.headers.get('etag') ?? null,
    threads: parsed.data,
    next: findNextPage(response.value.headers.get('link')),
    body: response.value.bodyText,
  };

  return { ok: true, value: { page, response: response.value, pollInterval } };
};

export const pollNotificationFeed = async (
  effects: GitHubEffects,
  feed: NotificationFeed,
  signal: AbortSignal,
): Promise<GitHubResult<NotificationPoll>> => {
  const stored = feed.pages[0];

  if (stored === undefined) {
    return invalid('The feed has no pages');
  }

  const fetched = await fetchPage(effects, stored.endpoint, stored.etag, signal);

  if (!fetched.ok) {
    return fetched;
  }

  const { page, pollInterval } = fetched.value;

  if (page === null) {
    return { ok: true, value: { kind: 'unchanged', pollInterval } };
  }

  return { ok: true, value: { kind: 'changed', page, pollInterval } };
};

export const readNotificationFeed = async (
  effects: GitHubEffects,
  request: NotificationFeedRequest,
  signal: AbortSignal,
): Promise<GitHubResult<NotificationFeedRead>> => {
  const storedByEndpoint = new Map(
    (request.previous?.pages ?? []).map((stored) => [stored.endpoint, stored]),
  );

  const pages: NotificationPage[] = [];
  let pollInterval: number | null = null;
  let endpoint: string | null = firstNotificationsEndpoint;
  let reusable = request.firstPage;

  while (endpoint !== null) {
    let page: NotificationPage;

    if (reusable === undefined) {
      const stored = storedByEndpoint.get(endpoint);

      // oxlint-disable-next-line eslint/no-await-in-loop -- each page URL comes from the previous page
      const fetched = await fetchPage(effects, endpoint, stored?.etag ?? null, signal);

      if (!fetched.ok) {
        return fetched;
      }

      pollInterval ??= fetched.value.pollInterval;

      if (fetched.value.page !== null) {
        page = fetched.value.page;
      } else if (stored === undefined) {
        return invalid(`Unexpected 304 for ${endpoint}`);
      } else {
        const link = fetched.value.response.headers.get('link');

        page = link === undefined ? stored : { ...stored, next: findNextPage(link) };
      }
    } else {
      page = reusable;
    }

    reusable = undefined;
    pages.push(page);
    endpoint = page.next;
  }

  const threads = pages.flatMap((entry) => entry.threads);

  return { ok: true, value: { feed: { pages }, threads, pollInterval } };
};

const namesStoredNext = (stored: NotificationPage, response: GhResponse): boolean => {
  const link = response.headers.get('link');

  return link === undefined || findNextPage(link) === stored.next;
};

export const verifyNotificationFeed = async (
  effects: GitHubEffects,
  feed: NotificationFeed,
  signal: AbortSignal,
): Promise<GitHubResult<NotificationVerification>> => {
  let pollInterval: number | null = null;

  for (const stored of feed.pages) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the pages are checked in order and stop at the first change
    const fetched = await fetchPage(effects, stored.endpoint, stored.etag, signal);

    if (!fetched.ok) {
      return fetched;
    }

    pollInterval = fetched.value.pollInterval ?? pollInterval;

    const unchanged =
      fetched.value.page === null && namesStoredNext(stored, fetched.value.response);

    if (!unchanged) {
      return { ok: true, value: { kind: 'changed', pollInterval } };
    }
  }

  return { ok: true, value: { kind: 'stable', pollInterval } };
};

const parseSavedBody = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

export const restoreNotificationFeed = (
  saved: readonly SavedNotificationPage[],
): GitHubResult<{ feed: NotificationFeed; threads: NotificationThread[] }> => {
  const pages: NotificationPage[] = [];

  for (const entry of saved) {
    const parsed = notificationPageSchema.safeParse(parseSavedBody(entry.body));

    if (!parsed.success) {
      return invalid(`Saved page ${entry.path} is not a notification page`);
    }

    pages.push({
      endpoint: entry.path,
      etag: entry.etag,
      threads: parsed.data,
      next: entry.next,
      body: entry.body,
    });
  }

  const threads = pages.flatMap((entry) => entry.threads);

  return { ok: true, value: { feed: { pages }, threads } };
};
