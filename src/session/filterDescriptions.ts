import type { Filter } from '../query.ts';
import { filterQuery } from '../query.ts';
import type { FilterRow } from './filterComposer.ts';
import { openThreads, threadsKnownMatching } from './sessionState.ts';
import type { Snapshot } from './sessionState.ts';

const fieldDescriptions = new Map([
  ['kind', 'The type of thread: pull request, issue, release, discussion, commit, or CI run.'],
  ['repo', 'The repository, as owner/name. Supports * wildcards.'],
  ['org', 'The owner of the repository. Supports * wildcards.'],
  ['author', 'Who opened the pull request or issue. @me is you. Supports * wildcards.'],
  ['reason', 'Why GitHub notified you.'],
  [
    'state',
    'Open, closed, or merged. Unknown until Zeta looks it up, so every thread shows meanwhile.',
  ],
  ['new', 'Activity by someone else since you last viewed the thread in Zeta.'],
  ['unread', 'Unread on GitHub. Viewing a thread in Zeta does not mark it read.'],
  ['age', 'Time since the last update, such as >7d or <2h. Units: m, h, d, w.'],
  ['title', 'Text in the title, ignoring case. Quote text with spaces.'],
]);

const valueDescriptions = new Map([
  ['kind:pr', 'Pull requests, drafts included.'],
  ['kind:issue', 'Issues.'],
  ['kind:release', 'New releases published in repositories you watch.'],
  ['kind:discussion', 'Threads in GitHub Discussions.'],
  ['kind:commit', 'Comments on commits.'],
  ['kind:ci', 'GitHub Actions workflow runs, usually a run you started that finished or failed.'],
  ['state:open', 'Pull requests and issues that are still open, drafts included.'],
  ['state:closed', 'Closed issues, and pull requests closed without being merged.'],
  ['state:merged', 'Pull requests that were merged.'],
  [
    'new:true',
    'Threads where someone else has been active since you last saw them in Zeta. The list marks them with ●.',
  ],
  [
    'new:false',
    'Threads you have seen in Zeta since their last update, or whose last update was your own.',
  ],
  [
    'unread:true',
    'Threads GitHub still marks as unread, because you have not opened them on GitHub since their last update.',
  ],
  ['unread:false', 'Threads you already opened on GitHub since their last update.'],
  ['author:@me', 'Pull requests and issues you opened with the account Zeta is signed in to.'],
  [
    'reason:approval_requested',
    'You were asked to review and approve a deployment that waits on a protection rule.',
  ],
  ['reason:assign', 'You are assigned to the issue or pull request.'],
  [
    'reason:author',
    'You opened the issue or pull request, so GitHub tells you about every new comment, review, and change.',
  ],
  ['reason:comment', 'You commented on the thread, so GitHub tells you about later comments.'],
  ['reason:ci_activity', 'A GitHub Actions workflow run that you triggered finished.'],
  ['reason:invitation', 'You accepted an invitation to contribute to the repository.'],
  ['reason:manual', 'You subscribed to this thread yourself, with the Subscribe button on GitHub.'],
  [
    'reason:member_feature_requested',
    'Members of your organization asked to turn on a feature, such as Copilot.',
  ],
  ['reason:mention', 'Someone @mentioned you by name in the thread.'],
  [
    'reason:review_requested',
    'You, or a team you belong to, were asked to review the pull request.',
  ],
  [
    'reason:security_alert',
    'GitHub found a security vulnerability in a dependency of the repository.',
  ],
  ['reason:security_advisory_credit', 'You were credited for your work on a security advisory.'],
  [
    'reason:state_change',
    "You changed the thread's state, such as closing an issue or merging a pull request, so GitHub tells you about what follows.",
  ],
  ['reason:subscribed', 'You watch the repository, so GitHub tells you about all its activity.'],
  ['reason:team_mention', 'Someone @mentioned a team you belong to.'],
]);

const kindWords: { subjectType: string; one: string; many: string }[] = [
  { subjectType: 'PullRequest', one: 'pull request', many: 'pull requests' },
  { subjectType: 'Issue', one: 'issue', many: 'issues' },
  { subjectType: 'Release', one: 'release', many: 'releases' },
  { subjectType: 'Discussion', one: 'discussion', many: 'discussions' },
  { subjectType: 'Commit', one: 'commit', many: 'commits' },
  { subjectType: 'CheckSuite', one: 'workflow run', many: 'workflow runs' },
];

const listed = (parts: string[]): string => {
  const last = parts.at(-1);

  if (parts.length < 2 || last === undefined) {
    return parts.join('');
  }

  return `${parts.slice(0, -1).join(', ')} and ${last}`;
};

const kindsOf = (subjectTypes: string[]): string => {
  const parts = kindWords.flatMap(({ subjectType, one, many }) => {
    const count = subjectTypes.filter((type) => type === subjectType).length;

    if (count === 0) {
      return [];
    }

    return [`${count} ${count === 1 ? one : many}`];
  });

  return listed(parts);
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const liveDescriptionOf = (snapshot: Snapshot, filter: Filter): string | undefined => {
  if (filter.negated) {
    return undefined;
  }

  const { field, value } = filter;
  const typedStar = value.includes('*');
  const query = filterQuery([filter]);

  if (query === null || !['repo', 'org', 'author'].includes(field)) {
    return undefined;
  }

  const matching = threadsKnownMatching(snapshot, openThreads(snapshot), query);
  const count = matching.length;

  if (typedStar && field === 'author') {
    return `Pull requests and issues by every author matching ${value}: ${count} in your inbox.`;
  }

  if (typedStar) {
    return `Threads from every repository matching ${value}: ${count} in your inbox.`;
  }

  if (field === 'repo') {
    const kinds = kindsOf(matching.map((thread) => thread.subjectType));

    const kindList = kinds === '' ? '' : `, ${kinds}`;

    return `Threads from the ${value} repository: ${count} in your inbox${kindList}.`;
  }

  if (field === 'org') {
    const repositories = new Set(matching.map((thread) => thread.repository)).size;
    const across = plural(repositories, 'repository', 'repositories');

    return `Threads from repositories owned by ${value}: ${count} in your inbox, across ${across}.`;
  }

  const bot = value.toLowerCase().endsWith('[bot]') ? ' This is a bot account.' : '';

  return `Pull requests and issues opened by ${value}: ${count} in your inbox.${bot}`;
};

const fieldTextOf = (field: string): string | undefined => fieldDescriptions.get(field);

const positiveTextOf = (snapshot: Snapshot, filter: Filter): string | undefined => {
  const explicit = valueDescriptions.get(`${filter.field}:${filter.value.toLowerCase()}`);

  return explicit ?? liveDescriptionOf(snapshot, filter) ?? fieldTextOf(filter.field);
};

const filterTextOf = (snapshot: Snapshot, filter: Filter): string | undefined => {
  const text = positiveTextOf(snapshot, { ...filter, negated: false });

  if (text === undefined || !filter.negated) {
    return text;
  }

  return `Hides these threads: ${text}`;
};

const rowFilterOf = (row: FilterRow): Filter | undefined => {
  if (row.kind === 'candidate' || row.kind === 'active') {
    return row.filter;
  }

  return row.kind === 'typed' ? row.filters[0] : undefined;
};

const draftFieldOf = (draft: string): string =>
  draft.trim().replace(/^-/, '').split(':')[0]?.toLowerCase() ?? '';

export const describeFilterRow = (snapshot: Snapshot, row: FilterRow | undefined): string => {
  if (row?.kind === 'field') {
    return fieldTextOf(row.field) ?? '';
  }

  const filter = row === undefined ? undefined : rowFilterOf(row);

  if (filter !== undefined) {
    return filterTextOf(snapshot, filter) ?? '';
  }

  if (!snapshot.filterDraft.includes(':') || row?.kind === 'error') {
    return '';
  }

  const field = draftFieldOf(snapshot.filterDraft);

  return fieldTextOf(field) ?? '';
};
