import { z } from 'zod';

import type { NotificationThread, ViewerLogin } from '../work/work.ts';
import { toViewerLogin } from '../work/work.ts';
import type { GhResponse, GitHubEffects, GitHubFailure, GitHubResult } from './ghApi.ts';
import { requestGh } from './ghApi.ts';
import type { NotificationFeed, NotificationPage } from './notifications.ts';
import { findNextPage, notificationPageSchema, readPollInterval } from './notifications.ts';

export { createGhRunner } from './ghApi.ts';
export type { GitHubEffects, GitHubFailure, GitHubResult } from './ghApi.ts';
export type { NotificationFeed, NotificationPage } from './notifications.ts';

interface FetchedPage {
  page: NotificationPage | null;
  response: GhResponse;
  pollInterval: number | null;
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

const viewerSchema = z.object({ login: z.string().min(1) });

const firstNotificationsEndpoint = '/notifications?all=true&per_page=50';

export const readViewer = async (
  effects: GitHubEffects,
  signal: AbortSignal,
): Promise<GitHubResult<ViewerLogin>> => {
  const response = await requestGh(effects, '/user', signal);

  if (!response.ok) {
    return response;
  }

  const parsed = viewerSchema.safeParse(response.value.body);

  if (!parsed.success) {
    return { ok: false, failure: { kind: 'invalidResponse', message: parsed.error.message } };
  }

  return { ok: true, value: toViewerLogin(parsed.data.login) };
};

const invalid = (message: string): { ok: false; failure: GitHubFailure } => ({
  ok: false,
  failure: { kind: 'invalidResponse', message },
});

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
