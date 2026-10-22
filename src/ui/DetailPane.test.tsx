import { afterEach, expect, test } from 'bun:test';

import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';

import { DetailPane } from './DetailPane.tsx';
import { pickPalette } from './palette.ts';
import {
  makeThread,
  threadsEffects,
  selectedRowText,
  threeThreads,
  pressAll,
  paneText,
  factsEffects,
  newMarkerThreads,
  newMarkerEffects,
  track,
  mount as untrackedMount,
} from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

test('at 90 columns and up, the side pane shows the selected thread and follows the cursor', async () => {
  const threads = [
    { ...makeThread(1, 'First title'), repository: 'acme/alpha' },
    { ...makeThread(2, 'Second title'), repository: 'acme/beta' },
  ];

  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threads),
    width: 100,
  });

  await press('r');
  await press('j');
  await press('j');

  const first = paneText(setup, 100);

  expect(first).toMatch(/Repo\s+acme\/alpha/);
  expect(first).toMatch(/Type\s+PR/);
  expect(first).toMatch(/Number\s+#1/);
  expect(first).toContain('First title');
  expect(first).toMatch(/Reason\s+subscribed/);
  expect(first).toMatch(/Updated\s+3h/);
  expect(first).toMatch(/Unread\s+yes/);

  await press('j');
  await press('j');

  const second = paneText(setup, 100);

  expect(second).toMatch(/Repo\s+acme\/beta/);
  expect(second).toMatch(/Number\s+#2/);
  expect(second).toContain('Second title');
  expect(second).not.toContain('First title');
  expect(second).not.toContain('acme/alpha');
});

const mixedThreads = [
  { ...makeThread(1, 'Alpha pull'), repository: 'acme/alpha' },
  {
    ...makeThread(2, 'Beta issue'),
    repository: 'acme/alpha',
    subjectType: 'Issue',
    reason: 'manual',
  },
  { ...makeThread(3, 'Gamma issue'), repository: 'acme/beta', subjectType: 'Issue' },
];

test('at 90 columns and up, the side pane summarizes a selected group and repo by type and reason', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(mixedThreads),
    width: 100,
  });

  await press('r');

  const group = paneText(setup, 100);

  expect(group).toMatch(/Threads\s+3/);
  expect(group).toMatch(/2\s+ISS/);
  expect(group).toMatch(/1\s+PR/);
  expect(group).toMatch(/1\s+manual/);
  expect(group).toMatch(/2\s+subscribed/);

  await press('j');

  const repo = paneText(setup, 100);

  expect(repo).toContain('acme/alpha');
  expect(repo).toMatch(/Threads\s+2/);
  expect(repo).toMatch(/1\s+ISS/);
  expect(repo).toMatch(/1\s+PR/);
  expect(repo).toMatch(/1\s+manual/);
  expect(repo).toMatch(/1\s+subscribed/);
});

test('the side pane counts distinct unknown types separately by full name', async () => {
  const threads = [
    { ...makeThread(1, 'Invite'), repository: 'acme/alpha', subjectType: 'RepositoryInvitation' },
    {
      ...makeThread(2, 'Alert'),
      repository: 'acme/alpha',
      subjectType: 'RepositoryVulnerabilityAlert',
    },
  ];

  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threads),
    width: 100,
  });

  await press('r');
  await press('j');

  const repo = paneText(setup, 100).replace(/[\s│]+/g, '');

  expect(repo).toContain('1RepositoryInvitation');
  expect(repo).toContain('1RepositoryVulnerabilityAlert');
  expect(repo).not.toContain('2REP');
});

test('below 90 columns, Enter on a thread opens the full-width detail and Escape returns to the same row', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await pressAll(press, ['r', 'j', 'j', 'j']);

  const before = selectedRowText(setup);

  await press('return');

  const detail = setup.captureCharFrame();

  expect(detail).toContain('Second');
  expect(detail).toMatch(/Repo\s+example\/repo/);
  expect(detail).not.toContain('First');
  expect(detail).not.toContain('Third');

  await press('escape');

  const list = setup.captureCharFrame();

  expect(list).toContain('First');
  expect(list).toContain('Second');
  expect(list).toContain('Third');
  expect(selectedRowText(setup)).toBe(before);
  expect(selectedRowText(setup)).toContain('Second');
});

test('j and k do not move the selection while the full-width detail is open', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(threeThreads),
  });

  await pressAll(press, ['r', 'j', 'j', 'j', 'return', 'j', 'k', 'k']);

  expect(setup.captureCharFrame()).toContain('Second');
  expect(setup.captureCharFrame()).not.toContain('First');

  await press('escape');

  expect(selectedRowText(setup)).toContain('Second');
});

test('the side pane shows the state and author of a thread with known facts', async () => {
  const threads = [makeThread(1, 'First title')];
  const effects = factsEffects(threads, new Map([['1', { state: 'merged', author: 'octo' }]]));

  const { setup, press } = await mount({ themeMode: 'dark', effects, width: 100 });

  await press('r');
  await press('j');
  await press('j');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/State\s+merged/);
  expect(frame).toMatch(/Author\s+octo/);
});

test('the side pane leaves out State and Author for a thread with no facts', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects([makeThread(1, 'First title')]),
    width: 100,
  });

  await press('r');
  await press('j');
  await press('j');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/Repo\s+example\/repo/);
  expect(frame).toMatch(/Unread\s+yes/);
  expect(frame).not.toContain('State');
  expect(frame).not.toContain('Author');
});

test('the side pane leaves out Author when the author is unknown', async () => {
  const threads = [makeThread(1, 'First title')];
  const effects = factsEffects(threads, new Map([['1', { state: 'closed', author: null }]]));

  const { setup, press } = await mount({ themeMode: 'dark', effects, width: 100 });

  await press('r');
  await press('j');
  await press('j');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/State\s+closed/);
  expect(frame).not.toContain('Author');
});

const renderThreadPane = async (isNew: boolean): Promise<string> => {
  const thread = makeThread(1, 'Fresh thread');
  const row = { kind: 'thread' as const, key: 't', thread, depth: 0, nodeRowKey: null, last: true };
  const newThreadIds = new Set(isNew ? [thread.id] : []);

  const setup = await act(() =>
    testRender(
      <DetailPane
        row={row}
        facts={undefined}
        newThreadIds={newThreadIds}
        palette={pickPalette('dark')}
        now={new Date(3 * 3_600_000)}
        width={40}
      />,
      { width: 40, height: 12 },
    ),
  );

  cleanups.push(() => {
    act(() => {
      setup.renderer.destroy();
    });
  });

  await act(() => setup.renderOnce());

  return setup.captureCharFrame();
};

test('the side pane of a new thread has a New line, and not for a thread that is not new', async () => {
  expect(await renderThreadPane(true)).toMatch(/New\s+yes/);
  expect(await renderThreadPane(false)).not.toMatch(/New\s/);
});

test('the side pane of a node with new threads shows their count on a New line', async () => {
  const withNew = await mount({
    themeMode: 'dark',
    effects: newMarkerEffects(newMarkerThreads, ['1']),
    width: 100,
  });

  await withNew.press('r');

  const without = await mount({
    themeMode: 'dark',
    effects: newMarkerEffects(newMarkerThreads, ['1', '2']),
    width: 100,
  });

  await without.press('r');

  expect(paneText(withNew.setup, 100)).toMatch(/New\s+1/);
  expect(paneText(without.setup, 100)).not.toMatch(/New\s/);
});

test('the side pane counts are whole numbers at the start of their line', async () => {
  const { setup, press } = await mount({
    themeMode: 'dark',
    effects: threadsEffects(mixedThreads),
    width: 100,
  });

  await press('r');

  const group = paneText(setup, 100);

  expect(group).toMatch(/^│?\s*2\s+ISS\s*$/m);
  expect(group).toMatch(/^│?\s*1\s+PR\s*$/m);
  expect(group).toMatch(/^│?\s*1\s+manual\s*$/m);
  expect(group).toMatch(/^│?\s*2\s+subscribed\s*$/m);
  expect(group).not.toMatch(/-\d/);
});
