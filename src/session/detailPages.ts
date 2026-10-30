import type { BrowserPage, NotificationThread, PullRequestCheck } from '../work/work.ts';
import { pageOfThread, readSubjectNumber } from '../work/work.ts';
import { pullRequestEntryOf } from './detailPullRequest.ts';
import { checkRecordId } from './detailPullRequestRecords.ts';
import type { DetailAnchor, PullRequestEntry } from './detailTransitions.ts';
import type { Snapshot } from './sessionState.ts';

const jobPath = /^\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)$/;

const parsedLinkOf = (link: string | null): URL | null => {
  if (link === null || !URL.canParse(link)) {
    return null;
  }

  return new URL(link);
};

const jobPageOf = (link: string | null, host: string): BrowserPage | null => {
  const url = parsedLinkOf(link);

  if (url === null || url.host !== host) {
    return null;
  }

  const match = jobPath.exec(url.pathname);
  const repository = match?.[1];
  const jobId = match?.[2];

  if (repository === undefined || jobId === undefined) {
    return null;
  }

  return { kind: 'checkJob', repository, jobId };
};

const jobPageOfCheck = (check: PullRequestCheck, host: string): BrowserPage | null => {
  if (check.kind === 'statusContext') {
    return null;
  }

  return jobPageOf(check.detailsUrl, host) ?? jobPageOf(check.url, host);
};

const anchoredRow = <Row>(
  rows: readonly Row[],
  anchor: DetailAnchor | undefined,
  idOf: (row: Row) => string,
): Row | undefined => {
  const recordId = anchor?.recordId;

  return rows.find((row) => idOf(row) === recordId);
};

const commitPageOf = (entry: PullRequestEntry, repository: string, number: number): BrowserPage => {
  const commit = anchoredRow(
    entry.sources.commits.records,
    entry.anchors.commits,
    (row) => row.oid,
  );

  if (commit === undefined) {
    return { kind: 'item', repository, number };
  }

  return { kind: 'commit', repository, sha: commit.oid };
};

const checkPageOf = (entry: PullRequestEntry, repository: string, number: number): BrowserPage => {
  const check = anchoredRow(entry.sources.checks.records, entry.anchors.checks, checkRecordId);
  const job = check === undefined ? null : jobPageOfCheck(check, entry.host);

  return job ?? { kind: 'pullRequestChecks', repository, number };
};

const pageOfTab = (entry: PullRequestEntry, repository: string, number: number): BrowserPage => {
  if (entry.tab === 'files') {
    return { kind: 'pullRequestFiles', repository, number };
  }

  if (entry.tab === 'checks') {
    return checkPageOf(entry, repository, number);
  }

  if (entry.tab === 'commits') {
    return commitPageOf(entry, repository, number);
  }

  return { kind: 'item', repository, number };
};

export const pullRequestPagesOf = (
  thread: NotificationThread,
  entry: PullRequestEntry,
): BrowserPage[] => {
  const number = readSubjectNumber(thread.subjectUrl);

  if (number === null) {
    return [pageOfThread(thread)];
  }

  return [pageOfTab(entry, thread.repository, number)];
};

export const activePullRequestEntry = (snapshot: Snapshot): PullRequestEntry | null => {
  const { activeKey, entries } = snapshot.detail;

  return pullRequestEntryOf(activeKey === null ? undefined : entries.get(activeKey));
};
