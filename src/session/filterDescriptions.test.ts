import { expect, test } from 'bun:test';

import { filterFields } from '../query.ts';
import type { NotificationThread } from '../work/work.ts';
import { describeFilterRow, filterCursorOf, filterRowsOf } from './session.ts';
import { describeRow, factsOf, makeHarness, makeThread, settle } from './sessionHarness.ts';

const loadInbox = async (
  entries: { id: string; overrides?: Partial<NotificationThread>; author?: string }[],
) => {
  const harness = makeHarness();
  const threads = entries.map(({ id, overrides }) => makeThread(id, overrides));

  await harness.load(...threads);

  harness.lookups[0]?.resolve(
    threads.map((thread, index) => factsOf(thread, entries[index]?.author ?? 'octo')),
  );

  await settle();
  harness.session.send({ kind: 'openFilters' });

  return harness.session;
};

const descriptionOfDraft = (session: Awaited<ReturnType<typeof loadInbox>>, draft: string) => {
  session.send({ kind: 'editFilterDraft', text: draft });

  const snapshot = session.getSnapshot();
  const row = filterRowsOf(snapshot)[filterCursorOf(snapshot)];

  return row === undefined ? undefined : describeFilterRow(snapshot, row);
};

test('every known field and value has a description', async () => {
  const session = await loadInbox([{ id: '1' }]);

  for (const field of filterFields) {
    const snapshot = session.getSnapshot();

    expect(describeFilterRow(snapshot, { kind: 'field', field })).not.toBe('');
  }

  const drafts = [
    'kind:pr',
    'kind:issue',
    'kind:release',
    'kind:discussion',
    'kind:commit',
    'kind:ci',
    'state:open',
    'state:closed',
    'state:merged',
    'new:true',
    'new:false',
    'unread:true',
    'unread:false',
    'reason:mention',
    'reason:review_requested',
  ];

  for (const draft of drafts) {
    expect(descriptionOfDraft(session, draft)).toBeTruthy();
  }
});

test('a repo row describes its threads with counts by kind, singular for one', async () => {
  const session = await loadInbox([
    { id: '1', overrides: { repository: 'acme/app' } },
    { id: '2', overrides: { repository: 'acme/app', subjectType: 'Issue' } },
    { id: '3', overrides: { repository: 'acme/app', subjectType: 'Issue' } },
    { id: '4', overrides: { repository: 'acme/web' } },
  ]);

  const description = descriptionOfDraft(session, 'repo:acme/app') ?? '';

  expect(description).toContain('acme/app');
  expect(description).toMatch(/\b3 in your inbox/);
  expect(description).toMatch(/\b1 pull request\b(?!s)/);
  expect(description).toMatch(/\b2 issues\b/);
  expect(description).not.toContain('release');
});

test('an org row gives its thread and repository counts', async () => {
  const session = await loadInbox([
    { id: '1', overrides: { repository: 'acme/app' } },
    { id: '2', overrides: { repository: 'acme/web' } },
    { id: '3', overrides: { repository: 'other/web' } },
  ]);

  const description = descriptionOfDraft(session, 'org:acme') ?? '';

  expect(description).toContain('acme');
  expect(description).toContain('2 in your inbox');
  expect(description).toContain('2 repositories');
});

test('an author row adds the bot note for a bot login', async () => {
  const session = await loadInbox([
    { id: '1', author: 'renovate[bot]' },
    { id: '2', author: 'octo' },
  ]);

  const bot = descriptionOfDraft(session, 'author:renovate[bot]') ?? '';
  const human = descriptionOfDraft(session, 'author:octo') ?? '';

  expect(bot).toContain('renovate[bot]');
  expect(bot).toContain('1 in your inbox');
  expect(bot).toContain('bot account');
  expect(human).toContain('octo');
  expect(human).toContain('1 in your inbox');
  expect(human).not.toContain('bot');
});

test('a typed value with a star counts the threads it matches', async () => {
  const session = await loadInbox([
    { id: '1', overrides: { repository: 'acme/app' } },
    { id: '2', overrides: { repository: 'acme/web' } },
    { id: '3', overrides: { repository: 'other/web' } },
  ]);

  const repositories = descriptionOfDraft(session, 'repo:acme/*') ?? '';
  const authors = descriptionOfDraft(session, 'author:oc*') ?? '';

  expect(repositories).toContain('acme/*');
  expect(repositories).toContain('2 in your inbox');
  expect(authors).toContain('oc*');
  expect(authors).toContain('3 in your inbox');
});

test('a typed row of several tokens describes every filter it adds', async () => {
  const session = await loadInbox([{ id: '1', overrides: { repository: 'acme/app' } }]);

  const description = descriptionOfDraft(session, 'repo:acme/app author:octo') ?? '';

  expect(description).toMatch(/\b2 filters\b/);
  expect(description).toContain('repo:acme/app');
  expect(description).toContain('author:octo');
});

test('a typed row keeps the quotes and the minus of its filter labels', async () => {
  const session = await loadInbox([{ id: '1' }]);

  const description = descriptionOfDraft(session, '-kind:pr title:"hello, author:octo"') ?? '';

  expect(description).toMatch(/\b2 filters\b/);
  expect(description).toContain('-kind:pr');
  expect(description).toContain('title:"hello, author:octo"');
});

test('a typed row of one token keeps the description of its filter', async () => {
  const session = await loadInbox([{ id: '1', overrides: { repository: 'acme/app' } }]);

  const description = descriptionOfDraft(session, 'repo:acme/app') ?? '';

  expect(description).toContain('acme/app');
  expect(description).not.toContain('Adds');
});

test('a repo value with no threads leaves out the kind list', async () => {
  const session = await loadInbox([{ id: '1', overrides: { repository: 'acme/app' } }]);

  const description = descriptionOfDraft(session, 'repo:x/y') ?? '';

  expect(description).toContain('x/y');
  expect(description).toContain('0 in your inbox');

  for (const word of ['pull request', 'issue', 'release', 'discussion', 'commit', 'workflow run']) {
    expect(description).not.toContain(word);
  }
});

test('a negated row hides what its positive row describes, and an explicit value text wins over live text', async () => {
  const session = await loadInbox([{ id: '1', author: 'octo' }]);

  const positive = descriptionOfDraft(session, 'kind:pr') ?? '';
  const negated = descriptionOfDraft(session, '-kind:pr') ?? '';
  const me = descriptionOfDraft(session, 'author:@me') ?? '';

  const liveAuthor = descriptionOfDraft(session, 'author:octo') ?? '';

  expect(positive).toContain('Pull requests');
  expect(positive).not.toMatch(/^Hides/);
  expect(negated).toMatch(/^Hides/);
  expect(negated).toContain(positive);
  expect(me).not.toBe('');
  expect(me).not.toBe(liveAuthor);
  expect(me).not.toMatch(/\d+ in your inbox/);
  expect(me).not.toBe(describeFilterRow(session.getSnapshot(), { kind: 'field', field: 'author' }));
  expect(descriptionOfDraft(session, 'author:@me')).toBe(me);
});

test('a negated row counts the threads it keeps, before and after it is applied', async () => {
  const { session, load } = makeHarness();

  await load(
    makeThread('1'),
    makeThread('2'),
    makeThread('3'),
    makeThread('4', { subjectType: 'Issue' }),
  );

  session.send({ kind: 'openFilters' });
  session.send({ kind: 'editFilterDraft', text: '-kind:pr' });

  const before = filterRowsOf(session.getSnapshot()).map(describeRow);

  session.send({ kind: 'applyFilterRow' });
  session.send({ kind: 'editFilterDraft', text: '-kind:pr' });

  const after = filterRowsOf(session.getSnapshot()).map(describeRow);

  session.send({ kind: 'editFilterDraft', text: '-kind' });

  const candidates = filterRowsOf(session.getSnapshot()).map(describeRow);

  expect(before[0]).toBe('typed -kind:pr 1');
  expect(before).not.toContain('candidate -kind:pr 3');
  expect(after).toEqual(['active -kind:pr 1']);
  expect(candidates).toContain('active -kind:pr 1');
  expect(candidates).toContain('candidate -kind:issue 3');
});
