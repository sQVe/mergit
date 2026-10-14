import type { Filter } from '../query.ts';
import { filterQuery } from '../query.ts';
import type { FilterRow } from './filterComposer.ts';
import { openThreads, threadsKnownMatching } from './sessionState.ts';
import type { Snapshot } from './sessionState.ts';

export interface InboxExamples {
  owner: string | null;
  author: string | null;
}

const fieldDescriptions = new Map([
  [
    'kind',
    'What the notification is about: a pull request, issue, release, discussion, commit comment, or GitHub Actions run (ci).',
  ],
  [
    'repo',
    'Only threads from one repository, written as owner/name. A * matches any text, so owner/* keeps every repository of one owner and */docs keeps every repository named docs.',
  ],
  [
    'org',
    'Only threads from repositories owned by one user or organization, the part of owner/name before the slash. A * matches any text, such as acme-*.',
  ],
  [
    'author',
    'Who opened the pull request or issue. @me is you, and bot accounts end in [bot], so -author:*[bot] hides every bot. Releases, commits, and CI runs have no author, so this filter never hides them.',
  ],
  [
    'reason',
    'Why GitHub sent you the notification, such as a review request, a mention, or activity on something you opened. Each value explains its case.',
  ],
  [
    'state',
    'The current state of the pull request or issue: open, closed, or merged. Zeta looks it up after the list loads, and until it knows, every thread stays visible.',
  ],
  [
    'new',
    'Whether someone else has been active on the thread since you last saw it in Zeta. A thread counts as seen once the cursor rests on it, and your own activity never makes it new.',
  ],
  [
    'unread',
    "GitHub's own read mark. Opening the thread on github.com or in another GitHub client marks it read; viewing it in Zeta does not.",
  ],
  [
    'age',
    "Time since the thread's last update. >7d keeps threads with no update for over a week, and <2h keeps threads updated in the last two hours. Units: m minutes, h hours, d days, w weeks.",
  ],
  [
    'title',
    'Threads whose title contains the text, ignoring case. Quote text with spaces, such as title:"release notes". Two title chips must both match.',
  ],
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

const ownerOf = (repository: string): string => repository.split('/')[0] ?? repository;

const mostCommon = (values: string[]): string | null => {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const ranked = [...counts].toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );

  return ranked[0]?.[0] ?? null;
};

export const inboxExamples = (snapshot: Snapshot): InboxExamples => {
  const threads = openThreads(snapshot);
  const viewer = snapshot.viewerLogin?.toLowerCase();

  const authors = threads.flatMap((thread) => {
    const author = snapshot.subjectFacts.get(thread.id)?.author;

    return author === null || author === undefined || author.toLowerCase() === viewer
      ? []
      : [author];
  });

  return {
    owner: mostCommon(threads.map((thread) => ownerOf(thread.repository))),
    author: mostCommon(authors),
  };
};

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

const fieldTextOf = (field: string, examples: InboxExamples): string | undefined => {
  const { owner, author } = examples;

  if (field === 'repo') {
    const ownerExample = owner ?? 'owner';
    const whose = owner ?? 'one owner';

    return `Only threads from one repository, written as owner/name. A * matches any text, so ${ownerExample}/* keeps every repository of ${whose} and */docs keeps every repository named docs.`;
  }

  if (field === 'org') {
    const pattern = owner === null ? 'acme-*' : `${owner}*`;

    return `Only threads from repositories owned by one user or organization, the part of owner/name before the slash. A * matches any text, such as ${pattern}.`;
  }

  if (field === 'author') {
    const example = author === null ? '' : `, such as author:${author}`;

    return `Who opened the pull request or issue${example}. @me is you, and bot accounts end in [bot], so -author:*[bot] hides every bot. Releases, commits, and CI runs have no author, so this filter never hides them.`;
  }

  return fieldDescriptions.get(field);
};

const positiveTextOf = (
  snapshot: Snapshot,
  filter: Filter,
  examples: InboxExamples,
): string | undefined => {
  const explicit = valueDescriptions.get(`${filter.field}:${filter.value.toLowerCase()}`);

  return explicit ?? liveDescriptionOf(snapshot, filter) ?? fieldTextOf(filter.field, examples);
};

const filterTextOf = (
  snapshot: Snapshot,
  filter: Filter,
  examples: InboxExamples,
): string | undefined => {
  const text = positiveTextOf(snapshot, { ...filter, negated: false }, examples);

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

// The text for the row under the cursor, or for the field being typed when no row has one.
export const describeFilterRow = (snapshot: Snapshot, row: FilterRow | undefined): string => {
  const examples = inboxExamples(snapshot);

  if (row?.kind === 'field') {
    return fieldTextOf(row.field, examples) ?? '';
  }

  const filter = row === undefined ? undefined : rowFilterOf(row);

  if (filter !== undefined) {
    return filterTextOf(snapshot, filter, examples) ?? '';
  }

  if (!snapshot.filterDraft.includes(':') || row?.kind === 'error') {
    return '';
  }

  const field = draftFieldOf(snapshot.filterDraft);

  return fieldTextOf(field, examples) ?? '';
};
