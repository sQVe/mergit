import type { PullRequestEntry, PullRequestTab } from '../session/session.ts';
import { checkRecordId } from '../session/session.ts';
import type {
  DetailCoverage,
  PullRequestCheck,
  PullRequestCommit,
  PullRequestFile,
  PullRequestOverview,
  PullRequestReviewer,
} from '../work/work.ts';
import type { DetailRecord } from './detailLayout.ts';
import { coverageTextOf, noDescription } from './detailLayout.ts';
import { formatAge } from './threadRow.ts';

export interface PullRequestTabContent {
  records: DetailRecord[];
  notices: string[];
}

type PullRequestSources = PullRequestEntry['sources'];

const shortOidLength = 7;
const noChecksText = 'No checks reported';
const noCommitsText = 'No commits.';

const tabLabels: Record<PullRequestTab, string> = {
  overview: 'Overview',
  commits: 'Commits',
  checks: 'Checks',
  files: 'Files',
};

const reviewDecisionLabels = {
  approved: 'approved',
  changesRequested: 'changes requested',
  reviewRequired: 'review required',
} as const;

const mergeableLabels = {
  mergeable: 'yes',
  conflicting: 'no, conflicts',
  unknown: 'unknown',
} as const;

export const pullRequestTabRowOf = (entry: PullRequestEntry): string =>
  entry.tabs.map((tab) => (tab === entry.tab ? `[${tabLabels[tab]}*]` : tabLabels[tab])).join(' ');

const shortOidOf = (oid: string): string => oid.slice(0, shortOidLength);

const listOf = (items: readonly string[]): string =>
  items.length === 0 ? 'none' : items.join(', ');

const countedListOf = (label: string, items: readonly string[], totalCount: number): string => {
  const count = items.length < totalCount ? ` (${items.length}/${totalCount} loaded)` : '';
  const text = listOf(items);

  return `${label}${count}: ${text}`;
};

const reviewerLabelOf = (reviewer: PullRequestReviewer): string => {
  if (reviewer.kind === 'account') {
    return `@${reviewer.login}`;
  }

  return reviewer.kind === 'team' ? reviewer.name : reviewer.typeName;
};

const overviewFactsOf = (overview: PullRequestOverview): string[] => {
  const state = overview.isDraft ? 'draft' : overview.state;

  const reviewDecision =
    overview.reviewDecision === null ? 'none' : reviewDecisionLabels[overview.reviewDecision];

  const reviewers = overview.reviewRequests.reviewers.map(reviewerLabelOf);

  return [
    `State: ${state}`,
    `Author: @${overview.author ?? 'ghost'}`,
    `Base: ${overview.base.refName} ${shortOidOf(overview.base.oid)}`,
    `Head: ${overview.head.refName} ${shortOidOf(overview.head.oid)}`,
    countedListOf('Labels', overview.labels.names, overview.labels.totalCount),
    countedListOf('Assignees', overview.assignees.logins, overview.assignees.totalCount),
    countedListOf('Review requests', reviewers, overview.reviewRequests.totalCount),
    `Review decision: ${reviewDecision}`,
    `Mergeable: ${mergeableLabels[overview.mergeable]}`,
    `Merge state: ${overview.mergeStateStatus}`,
  ];
};

const overviewRecordsOf = (overview: PullRequestOverview): DetailRecord[] => {
  const description = overview.body.trim() === '' ? noDescription : overview.body;

  return [
    {
      id: 'overview:facts',
      digest: overview.digest,
      heading: null,
      text: overviewFactsOf(overview).join('\n'),
    },
    { id: 'overview:description', digest: overview.digest, heading: null, text: description },
  ];
};

const commitRecordsOf = (
  commits: PullRequestSources['commits'],
  now: Date,
  loaded: boolean,
): DetailRecord[] => {
  if (commits.records.length === 0 && loaded) {
    return [{ id: 'commits:empty', digest: noCommitsText, heading: null, text: noCommitsText }];
  }

  return commits.records.map((commit: PullRequestCommit) => ({
    id: commit.oid,
    digest: [commit.oid, commit.headline, commit.author, commit.authoredDate].join('\n'),
    heading: `@${commit.author ?? 'ghost'} / ${formatAge(commit.authoredDate, now)} ago`,
    text: `${shortOidOf(commit.oid)} ${commit.headline}`,
  }));
};

const checkSummaryOf = (
  check: PullRequestCheck,
): { label: string; result: string; link: string | null } => {
  if (check.kind === 'statusContext') {
    return { label: check.context, result: check.state, link: check.targetUrl };
  }

  return {
    label: check.name,
    result: check.conclusion ?? check.status,
    link: check.detailsUrl ?? check.url,
  };
};

const checkTextOf = (check: PullRequestCheck): string => {
  const { label, result, link } = checkSummaryOf(check);
  const lines = [`${label}: ${result.toLowerCase()}`];

  if (link !== null) {
    lines.push(link);
  }

  return lines.join('\n');
};

const checkRecordOf = (check: PullRequestCheck): DetailRecord => {
  const text = checkTextOf(check);

  return { id: checkRecordId(check), digest: text, heading: null, text };
};

const rollupRecordsOf = (checks: PullRequestSources['checks'], loaded: boolean): DetailRecord[] => {
  if (checks.state === null) {
    return loaded
      ? [{ id: 'checks:rollup', digest: noChecksText, heading: null, text: noChecksText }]
      : [];
  }

  const commit = checks.commitOid === null ? '' : ` on ${shortOidOf(checks.commitOid)}`;
  const text = `Rollup: ${checks.state.toLowerCase()}${commit}`;

  return [{ id: 'checks:rollup', digest: text, heading: null, text }];
};

const sourceHeadRecords = (source: 'checks' | 'files', headOid: string | null): DetailRecord[] => {
  if (headOid === null) {
    return [];
  }

  const shortOid = shortOidOf(headOid);
  const text = `Head: ${shortOid}`;

  return [{ id: `${source}:head`, digest: headOid, heading: null, text }];
};

const checkRecordsOf = (checks: PullRequestSources['checks'], loaded: boolean): DetailRecord[] => [
  ...sourceHeadRecords('checks', checks.headOid),
  ...rollupRecordsOf(checks, loaded),
  ...checks.records.map(checkRecordOf),
];

const fileRecordOf = (file: PullRequestFile): DetailRecord => {
  const text = `${file.changeType.toLowerCase()} ${file.path} +${file.additions} -${file.deletions}`;

  return { id: `file:${file.path}`, digest: text, heading: null, text };
};

const fileRecordsOf = (files: PullRequestSources['files']): DetailRecord[] => {
  const totalsText =
    files.totals === null
      ? null
      : `${files.totals.changedFiles} changed files, +${files.totals.additions} -${files.totals.deletions}`;

  const totals =
    totalsText === null
      ? []
      : [{ id: 'files:totals', digest: totalsText, heading: null, text: totalsText }];

  return [
    ...sourceHeadRecords('files', files.headOid),
    ...totals,
    ...files.records.map(fileRecordOf),
  ];
};

const recordsOfTab = (entry: PullRequestEntry, now: Date): DetailRecord[] => {
  const { sources } = entry;
  const loaded = sources[entry.tab].coverage === 'loaded';

  if (entry.tab === 'overview') {
    return sources.overview.record === null ? [] : overviewRecordsOf(sources.overview.record);
  }

  if (entry.tab === 'commits') {
    return commitRecordsOf(sources.commits, now, loaded);
  }

  if (entry.tab === 'checks') {
    return checkRecordsOf(sources.checks, loaded);
  }

  return fileRecordsOf(sources.files);
};

const loadedCountOf = (entry: PullRequestEntry): number => {
  const { sources } = entry;

  if (entry.tab === 'overview') {
    return Number(sources.overview.record !== null);
  }

  if (entry.tab === 'commits') {
    return sources.commits.records.length;
  }

  if (entry.tab === 'checks') {
    return sources.checks.records.length;
  }

  return sources.files.records.length;
};

const openHintOf = (coverage: DetailCoverage, openKey: string | undefined): string[] => {
  if (coverage !== 'failed' || openKey === undefined) {
    return [];
  }

  return [`Press ${openKey} to open it on GitHub.`];
};

const noticesOf = (
  coverage: DetailCoverage,
  message: string | null,
  loaded: number,
  openKey: string | undefined,
): string[] => {
  const text =
    coverage === 'unsupported' ? 'Unsupported' : coverageTextOf(coverage, message, loaded);

  if (text === null) {
    return [];
  }

  return [text, ...openHintOf(coverage, openKey)];
};

export const pullRequestTabContentOf = (
  entry: PullRequestEntry,
  now: Date,
  openKey: string | undefined,
): PullRequestTabContent => {
  const { coverage, message } = entry.sources[entry.tab];

  return {
    records: recordsOfTab(entry, now),
    notices: noticesOf(coverage, message, loadedCountOf(entry), openKey),
  };
};
