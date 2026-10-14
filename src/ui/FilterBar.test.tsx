import { afterEach, expect, test } from 'bun:test';

import { typeText, track, mountFilters as untrackedMountFilters } from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mountFilters = track(cleanups, untrackedMountFilters);

test('chips that do not fit collapse into +N more', async () => {
  const mounted = await mountFilters(40);
  const { setup, press, settle } = mounted;

  for (const text of ['author:octo', 'author:mona', 'repo:acme/app']) {
    await press('f');
    await typeText(setup, settle, text);
    await press('return');
    await press('escape');
  }

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toMatch(/\+\d+ more/);
  expect(chipRow).toContain('author:octo');
  expect(chipRow).not.toContain('repo:acme/app');
});

test('chips of a field are joined by or only when positive; negated chips stand apart', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'repo:a repo:b -repo:c -repo:d');
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain('repo:a or repo:b');
  expect(chipRow).not.toContain('or -repo');
  expect(chipRow).not.toContain('-repo:c or');
  expect(chipRow).toContain('-repo:c');
  expect(chipRow).toContain('-repo:d');
});

test('positive chips of a field stay joined by or when a negated chip was added between them', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'repo:a -repo:c repo:b');
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain('repo:a or repo:b');
  expect(chipRow).toContain('-repo:c');
  expect(chipRow).not.toContain('or -repo');
});

test('chips of age are joined by and, chips of repo by or', async () => {
  const mounted = await mountFilters(100);
  const { setup, press, settle } = mounted;

  await press('f');
  await typeText(setup, settle, 'age:>7d age:<30d repo:acme/app repo:acme/web');
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow).toContain('age:>7d and age:<30d');
  expect(chipRow).toContain('repo:acme/app or repo:acme/web');
});

test('with narrow width the chip bar shows the first chip before +N more', async () => {
  const { setup, press, settle } = await mountFilters(30);

  await press('f');
  await typeText(setup, settle, `repo:acme/${'a'.repeat(40)} author:octo author:mona kind:pr`);
  await press('return');

  const chipRow = setup.captureCharFrame().split('\n')[0] ?? '';

  expect(chipRow.startsWith('repo:acme/a')).toBe(true);
  expect(chipRow).toContain('…');
  expect(chipRow).toContain('more');
});
