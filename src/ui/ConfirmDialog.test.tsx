import { afterEach, expect, test } from 'bun:test';

import { catalog } from '../commands.ts';
import type { Command } from '../commands.ts';
import {
  treeThread,
  fourRepoThreads,
  mount as untrackedMount,
  threadsEffects,
  track,
  mountWithGroup as untrackedMountWithGroup,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);
const mountWithGroup = track(cleanups, untrackedMountWithGroup);

const openedPages = ['a', 'b', 'c', 'd'].map((name) => ({
  kind: 'repo',
  repository: `example/${name}`,
}));

const hasOpenIntent = (sent: unknown[]) =>
  sent.some((intent) => (intent as { kind: string }).kind === 'openInBrowser');

test('o on a group node over 4 repos shows the dialog and opens nothing', async () => {
  const { setup, press, sent, opens } = await mountWithGroup();

  await press('o');

  expect(setup.captureCharFrame()).toContain('Open 4 repos');
  expect(hasOpenIntent(sent)).toBe(false);
  expect(opens).toEqual([]);
});

for (const key of ['y', 'return']) {
  test(`${key} in the dialog opens each repo once and closes the dialog`, async () => {
    const { setup, press, settle, opens } = await mountWithGroup();

    await press('o');
    await press(key);
    await settle();

    expect(opens).toEqual(openedPages);
    expect(setup.captureCharFrame()).not.toContain('Open 4 repos');
  });
}

for (const key of ['n', 'escape']) {
  test(`${key} in the dialog opens nothing and closes the dialog`, async () => {
    const { setup, press, settle, sent, opens } = await mountWithGroup();

    await press('o');
    await press(key);
    await settle();

    expect(opens).toEqual([]);
    expect(hasOpenIntent(sent)).toBe(false);
    expect(setup.captureCharFrame()).not.toContain('Open 4 repos');
  });
}

test('confirm opens the repos captured when the dialog opened, not the refreshed group', async () => {
  let current = fourRepoThreads;
  const { setup, session, press, settle, opens } = await mountWithGroup(() => current);

  await press('o');

  current = [
    ...fourRepoThreads.slice(0, 2),
    treeThread(9, 'Thread z', {
      reason: 'review_requested',
      repository: 'example/z',
      subjectUrl: null,
    }),
  ];

  session.send({ kind: 'refresh' });
  await settle();

  expect(setup.captureCharFrame()).toContain('Open 4 repos');

  await press('y');
  await settle();

  expect(opens).toEqual(openedPages);
});

test('a key that shows messages does nothing while the dialog is open', async () => {
  const commands = catalog.filter((command) => command.id !== 'showMessages');
  const showMessages = catalog.find((command) => command.id === 'showMessages') as Command;

  commands.push({ ...showMessages, keys: ['m'] });

  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(fourRepoThreads),
    catalog: commands,
  });

  await press('r');
  await press('o');
  await press('m');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Open 4 repos');
  expect(frame).not.toContain('No messages yet');
});

for (const key of ['y', 'n']) {
  test(`o shows the dialog again after ${key} closed it`, async () => {
    const { setup, press, settle } = await mountWithGroup();

    await press('o');
    await press(key);
    await settle();
    await press('o');

    expect(setup.captureCharFrame()).toContain('Open 4 repos');
  });
}

test('n leaves help open when no dialog is open', async () => {
  const { setup, press, settle } = await mountWithGroup();

  await press('?');
  await press('n');
  await settle();

  expect(setup.captureCharFrame()).toContain('Toggle help');
});

test('o shows the dialog after help opened and closed', async () => {
  const { setup, press, settle } = await mountWithGroup();

  await press('?');
  await press('?');
  await settle();
  await press('o');

  expect(setup.captureCharFrame()).toContain('Open 4 repos');
});
