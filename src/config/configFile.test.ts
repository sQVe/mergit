import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalog } from '../commands.ts';
import { loadConfig } from './config.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const makeHome = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'mergit-config-'));
  directories.push(directory);

  return directory;
};

test('a missing config file gives the default catalog and no notices', async () => {
  const home = await makeHome();
  const result = loadConfig({ XDG_CONFIG_HOME: home });

  expect(result).toEqual({ ok: true, catalog, notices: [] });
});

test('the config path falls back to the home directory', async () => {
  const home = await makeHome();
  await mkdir(join(home, '.config', 'mergit'), { recursive: true });

  await writeFile(
    join(home, '.config', 'mergit', 'config.json'),
    JSON.stringify({ version: 1, keys: { refresh: ['R'] } }),
  );

  const result = loadConfig({ HOME: home });
  const refreshKeys = result.ok && result.catalog.find((command) => command.id === 'refresh')?.keys;

  expect(refreshKeys).toEqual(['shift+r']);
});

for (const [setting, environment] of [
  ['unset', { HOME: '/test-home' }],
  ['empty', { HOME: '/test-home', XDG_CONFIG_HOME: '' }],
] as const) {
  test(`${setting} XDG_CONFIG_HOME reads and loads the config under HOME`, () => {
    const readPaths: string[] = [];

    const result = loadConfig(environment, {
      readFile: (path) => {
        readPaths.push(path);

        return { kind: 'text', text: '{"version":1,"keys":{"refresh":["R"]}}' };
      },
    });

    const refreshKeys =
      result.ok && result.catalog.find((command) => command.id === 'refresh')?.keys;

    expect(readPaths).toEqual(['/test-home/.config/mergit/config.json']);
    expect(refreshKeys).toEqual(['shift+r']);
  });
}

for (const [setting, environment] of [
  ['both unset', {}],
  ['HOME empty and XDG_CONFIG_HOME unset', { HOME: '' }],
  ['HOME unset and XDG_CONFIG_HOME empty', { XDG_CONFIG_HOME: '' }],
  ['both empty', { HOME: '', XDG_CONFIG_HOME: '' }],
] as const) {
  test(`config uses defaults without reading a file when config homes are ${setting}`, () => {
    const readPaths: string[] = [];

    const result = loadConfig(environment, {
      readFile: (path) => {
        readPaths.push(path);

        return { kind: 'failed', reason: 'No config path should be read.' };
      },
    });

    expect(result).toEqual({ ok: true, catalog, notices: [] });
    expect(readPaths).toEqual([]);
  });
}

test('a config path that is a directory reports a read failure without changing it', async () => {
  const home = await makeHome();
  const path = join(home, 'mergit', 'config.json');

  await mkdir(path, { recursive: true });

  const result = loadConfig({ XDG_CONFIG_HOME: home });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.message).toContain(path);
  expect(!result.ok && result.message).toContain('cannot be read');
  expect((await stat(path)).isDirectory()).toBe(true);
});

test('bad JSON stops with the path', async () => {
  const home = await makeHome();
  const path = join(home, 'mergit', 'config.json');

  await mkdir(join(home, 'mergit'));
  await writeFile(path, '{ "version": ');

  const result = loadConfig({ XDG_CONFIG_HOME: home });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.message).toContain(path);
  expect(!result.ok && result.message).toContain('JSON');
});
