import { afterEach, expect, test } from 'bun:test';

import { loadConfig } from '../src/config/config.ts';
import { helpWindowOf } from '../src/ui/helpWindow.ts';
import {
  feedEffects,
  makeThread,
  pressAll,
  track,
  mount as untrackedMount,
} from '../src/ui/uiHarness.tsx';
import { toIssueId, toViewerId, toViewerLogin } from '../src/work/work.ts';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

const configured = (config: unknown) => {
  const loaded = loadConfig(
    { XDG_CONFIG_HOME: '/test-config' },
    { readFile: () => ({ kind: 'text', text: JSON.stringify(config) }) },
  );

  if (!loaded.ok) {
    throw new Error(loaded.message);
  }

  return loaded;
};

test('remapped tab keys switch reader tabs and show in help', async () => {
  const { catalog } = configured({ version: 1, keys: { nextTab: ['t'], previousTab: ['y'] } });

  const issue = {
    ...makeThread(1, 'Login redirect'),
    subjectType: 'Issue',
    subjectUrl: 'https://api.github.com/repos/harbor/console/issues/218',
    repository: 'harbor/console',
  };

  const read = {
    kind: 'issue' as const,
    viewer: { id: toViewerId('U_octocat'), login: toViewerLogin('octocat') },
    subject: { id: toIssueId('I_218'), number: 218, url: 'https://github.com/i/218' },
    overview: {
      id: toIssueId('I_218'),
      number: 218,
      url: 'https://github.com/i/218',
      title: 'Login redirect',
      body: 'Overview text',
      state: 'open' as const,
      author: 'nora',
      createdAt: '1970-01-01T00:00:00Z',
      updatedAt: '1970-01-01T00:00:00Z',
      lastEditedAt: null,
      labels: { names: [], totalCount: 0 },
      assignees: { logins: [], totalCount: 0 },
      digest: 'overview',
    },
    comments: { records: [], totalCount: 0, hasNextPage: false, endCursor: null },
  };

  const effects = {
    ...feedEffects(() => [issue]),
    readIssueDetail: () => Promise.resolve({ ok: true as const, value: read }),
  };

  const { setup, press } = await mount({ catalog, effects, width: 80, height: 24 });

  await pressAll(press, ['r', 'j', 'j', 'return']);
  await press('l');

  expect(setup.captureCharFrame()).toContain('[Overview*]');

  await press('t');

  expect(setup.captureCharFrame()).toContain('[Discussion*]');

  await press('y');

  expect(setup.captureCharFrame()).toContain('[Overview*]');

  const rows = helpWindowOf(catalog, 100, 100).lines;

  expect(rows).toContainEqual({ kind: 'row', keys: 't', label: 'Next tab' });
  expect(rows).toContainEqual({ kind: 'row', keys: 'y', label: 'Previous tab' });
});
