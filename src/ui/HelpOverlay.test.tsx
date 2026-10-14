import { afterEach, expect, test } from 'bun:test';

import { catalog } from '../commands.ts';
import { idleEffects, track, mount as untrackedMount } from './uiHarness.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const mount = track(cleanups, untrackedMount);

test('? opens the overlay with every command label and ? closes it', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 50);

  await press('?');

  const open = setup.captureCharFrame();
  const listed = catalog.filter((command) => command.scope !== 'confirm');

  for (const command of listed) {
    expect(open).toContain(command.label);
  }

  expect(open).not.toContain('Confirm opening');

  await press('?');

  const closed = setup.captureCharFrame();

  for (const command of catalog) {
    expect(closed).not.toContain(command.label);
  }
});

test('Escape closes the overlay', async () => {
  const { setup, press } = await mount();

  await press('?');
  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Toggle help');
});

test('escape does nothing while the overlay is closed', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 30);

  await press('escape');

  expect(setup.captureCharFrame()).not.toContain('Close help');
});

test('the overlay lists the close help command from the catalog', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 30);

  await press('?');

  expect(setup.captureCharFrame()).toContain('Close help');
});

test('the help overlay lists the search line keys and still shows Close help', async () => {
  const { setup, press } = await mount(null, idleEffects, 60, false, 30);

  await press('?');

  const frame = setup.captureCharFrame();

  for (const id of ['submitInput', 'cancelInput', 'clearInput', 'closeEmptyInput']) {
    const command = catalog.find((candidate) => candidate.id === id);

    expect(frame).toContain(command?.label ?? 'missing');
  }

  expect(frame).toContain('Close help');
});
