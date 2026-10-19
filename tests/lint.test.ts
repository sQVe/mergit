import { expect, it, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// The linter picks its default output format from the environment, such as GitHub Actions or an AI
// agent. Tests that read paths from diagnostics need one line per diagnostic.
const unixFormat = ['--format', 'unix'];

it('rejects lint warnings in project checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergit-lint-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'warning.js');
  await writeFile(fixture, 'console.log("warning fixture");\n');

  const result = spawnSync(process.execPath, ['run', 'lint', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('eslint(no-console)');
}, 30_000);

it('runs house style through the style command but not plain lint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergit-style-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'style.ts');
  await writeFile(fixture, 'export const MAX_RETRIES = 3;\n');

  const run = (script: string) =>
    spawnSync(process.execPath, ['run', script, fixture], {
      cwd: root,
      env: { ...process.env, SEAM_STYLE: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });

  const ordinary = run('lint');
  const style = run('style:check');

  expect(ordinary.error).toBeUndefined();
  expect(ordinary.status).toBe(0);
  expect(ordinary.stdout).not.toContain('naming-convention');
  expect(style.error).toBeUndefined();
  expect(style.status).toBe(1);
  expect(style.stdout).toContain('naming-convention');
}, 60_000);

it.each(['lint', 'style:check'])(
  'keeps imports inside module boundaries through %s',
  async (script) => {
    const directory = await mkdtemp(join(tmpdir(), 'mergit-boundaries-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    // The `src` segment above the project root must not count as the application source.
    const project = join(directory, 'src', 'project');

    const configUrl = pathToFileURL(join(project, 'src', 'config.ts')).href;

    const privateSessionUrl = pathToFileURL(
      join(project, 'src', 'session', 'valueImports.ts'),
    ).href;

    const fixtures: [string, string[], number][] = [
      [
        'src/work/work.ts',
        [
          "import { helper } from './helper.ts';",
          "import { nested } from './nested/deep';",
          'export const work = helper + nested;',
        ],
        0,
      ],
      ['src/work/helper.ts', ['export const helper = 1;'], 0],
      [
        'src/work/nested/deep.ts',
        ["import { helper } from '../helper.ts';", 'export const nested = helper;'],
        0,
      ],
      [
        'src/work/work.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { work } from './work.ts';",
          "it('works', () => expect(work).toBe(2));",
        ],
        0,
      ],
      [
        'src/config.ts',
        ["import { invariant } from './invariant.ts';", 'export const config = invariant;'],
        0,
      ],
      [
        'src/work/checked.ts',
        ["import { invariant } from '../invariant.ts';", 'export const checked = invariant;'],
        0,
      ],
      [
        'src/session/checked.ts',
        ["import { invariant } from '../invariant.ts';", 'export const checked = invariant;'],
        0,
      ],
      [
        'src/ui/checked.tsx',
        ["import { invariant } from '../invariant.ts';", 'export const checked = invariant;'],
        0,
      ],
      [
        'src/invariant.ts',
        [
          "import { readFile } from 'node:fs';",
          "import { useState } from 'react';",
          "import { work } from './work/work.ts';",
          'export const invariant = [readFile, useState, work];',
        ],
        3,
      ],
      [
        'src/config.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { config } from './config.ts';",
          "it('configures', () => expect(config).toBe(1));",
        ],
        0,
      ],
      [
        'src/github/github.ts',
        [
          "import { invariant } from '../invariant.ts';",
          "import { work } from '../work/work';",
          'export const github = [invariant, work];',
          'export interface Github { id: number }',
        ],
        0,
      ],
      [
        'src/localState.ts',
        [
          "import { invariant } from './invariant.ts';",
          "import { work } from './work/work.js';",
          'export const localState = [invariant, work];',
          'export interface LocalState { id: number }',
        ],
        0,
      ],
      [
        'src/actions.ts',
        [
          "import { readFile } from 'node:fs/promises';",
          "import { config } from './config.ts';",
          "import { invariant } from './invariant.ts';",
          "import { work } from './work/work.ts';",
          'export const actions = [readFile, config, invariant, work];',
          'export interface Actions { id: number }',
        ],
        0,
      ],
      [
        'src/session/session.ts',
        [
          "import type { Github } from '../github/github.ts';",
          "import { type LocalState } from '../localState.ts';",
          "import { work } from '../work/work.ts';",
          "export type { Actions } from '../actions.ts';",
          "export type GithubIdentifier = import('../github/github.ts').Github['id'];",
          'const loaded = await import(`../work/work.ts`);',
          'export const session = [work, loaded];',
          'export type Sources = [Github, LocalState];',
        ],
        0,
      ],
      [
        'src/commands.ts',
        [
          "import { invariant } from './invariant.ts';",
          "import { session } from './session/session.ts';",
          "import { work } from './work/work.ts';",
          'export const commands = [invariant, session, work];',
        ],
        0,
      ],
      [
        'src/ui/ui.tsx',
        [
          "import { useState } from 'react';",
          "import { createRoot } from '@opentui/react';",
          "import { commands } from '../commands.ts';",
          "import { session } from '../session/session.ts';",
          "import { view } from './view.tsx';",
          'export const ui = [useState, createRoot, commands, session, view];',
        ],
        0,
      ],
      ['src/ui/view.tsx', ['export const view = 1;'], 0],
      [
        'src/ui/ui.test.tsx',
        [
          "import { expect, it } from 'bun:test';",
          "import { ui } from './ui.tsx';",
          "it('renders', () => expect(ui).toHaveLength(5));",
        ],
        0,
      ],
      [
        'src/terminal.tsx',
        [
          "import process from 'node:process';",
          "import { commands } from './commands.ts';",
          "import { config } from './config.ts';",
          "import { invariant } from './invariant.ts';",
          "import { session } from './session/session.ts';",
          "import { ui } from './ui/ui.tsx';",
          'export const terminal = [process, commands, config, invariant, session, ui];',
        ],
        0,
      ],
      [
        'src/index.ts',
        [
          "import { actions } from './actions.ts';",
          "import { commands } from './commands.ts';",
          "import { config } from './config.ts';",
          "import { github } from './github/github.ts';",
          "import { invariant } from './invariant.ts';",
          "import { localState } from './localState.ts';",
          "import { session } from './session/session.ts';",
          "import { terminal } from './terminal.tsx';",
          "import { ui } from './ui/ui.tsx';",
          "import { work } from './work/work.ts';",
          'export const index = [actions, commands, config, github, invariant, localState, session, terminal, ui, work];',
        ],
        0,
      ],
      [
        'scripts/tool.ts',
        [
          "import { readFile } from 'node:fs';",
          "import { helper } from '../src/work/helper.ts';",
          'export const tool = [readFile, helper];',
        ],
        0,
      ],
      ['src/utils.ts', ['export const utils = 1;'], 1],
      ['src/helpers/format.ts', ['export const format = 1;'], 1],
      ['src/session.ts', ['export const misplaced = 1;'], 1],
      ['src/config/values.ts', ['export const values = 1;'], 1],
      [
        'src/work/refusedModules.ts',
        [
          "import { config } from '../config.ts';",
          "import type { Github } from '../github/github.ts';",
          "export * from '../session/session.ts';",
          'export const refused: [number, Github?] = [config];',
        ],
        3,
      ],
      [
        'src/session/valueImports.ts',
        [
          "import { github } from '../github/github.ts';",
          "import { type Actions, actions } from '../actions.ts';",
          "export { localState } from '../localState.ts';",
          "const loaded = await import('../localState.ts');",
          'export const values = [github, actions, loaded];',
          'export type Value = Actions;',
        ],
        4,
      ],
      [
        'src/session/typeImports.ts',
        ["export type Command = import('../commands.ts').Command;"],
        1,
      ],
      [
        'src/ui/privateImports.tsx',
        [
          "import { helper } from '../work/helper.ts';",
          "import { work } from '../work';",
          "import { nested } from '../work/nested/deep.ts';",
          "export * from '../session/valueImports.ts';",
          'export const imported = [helper, work, nested];',
        ],
        4,
      ],
      [
        'src/github/escape.ts',
        [
          "import { outside } from '../../outside.ts';",
          "import { work } from '../../src/work/work.ts';",
          'export const escaped = [outside, work];',
        ],
        1,
      ],
      [
        'src/work/runtime.ts',
        [
          "import { readFile } from 'node:fs';",
          "import path from 'path';",
          "import { $ } from 'bun';",
          "import { test } from 'bun:test';",
          "import { useState } from 'react';",
          "import { jsx } from 'react/jsx-runtime';",
          "import { createCliRenderer } from '@opentui/core';",
          "import { parse } from 'yaml';",
          'export const runtime = [readFile, path, $, test, useState, jsx, createCliRenderer, parse];',
        ],
        7,
      ],
      [
        'src/ui/runtime.tsx',
        [
          "import { readFileSync } from 'fs';",
          "import { useState } from 'react';",
          "import { createRoot } from '@opentui/react';",
          'export const runtime = [readFileSync, useState, createRoot];',
        ],
        1,
      ],
      [
        'src/commands.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { readFile } from 'node:fs/promises';",
          "import { commands } from './commands.ts';",
          "it('reads', () => expect([readFile, commands]).toHaveLength(2));",
        ],
        1,
      ],
      [
        'src/work/dynamic.ts',
        [
          "const name = 'helper';",
          'export const computed = await import(name);',
          // eslint-disable-next-line eslint/no-template-curly-in-string -- Fixture source with an interpolated import.
          'export const interpolated = await import(`./${name}.ts`);',
          "export const refused = await import('../config.ts');",
          "export const allowed = await import('./helper.ts');",
        ],
        3,
      ],
      ['src/work/directory.ts', ["export * from '.';"], 1],
      [
        'src/work/fileUrls.ts',
        [
          `export { config } from '${configUrl}';`,
          `export const loaded = await import('${privateSessionUrl}');`,
        ],
        2,
      ],
    ];

    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'package.json'), '{}\n');

    for (const [file, lines] of fixtures) {
      const path = join(project, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${lines.join('\n')}\n`);
    }

    const result = spawnSync(process.execPath, ['run', script, project, ...unixFormat], {
      cwd: root,
      env: { ...process.env, SEAM_STYLE: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });

    const diagnostics = result.stdout
      .split('\n')
      .filter((line) => line.includes('mergit(module-boundaries)'));

    // The linter prints a path relative to its working directory when the file sits below it.
    const reportedPath = (diagnostic: string) => {
      const [, path = ''] = diagnostic.match(/^(.+?):\d+:\d+:/) ?? [];

      return resolve(root, path);
    };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);

    for (const [file, , count] of fixtures) {
      const fileDiagnostics = diagnostics.filter(
        (line) => reportedPath(line) === join(project, file),
      );

      expect({ file, diagnostics: fileDiagnostics.length }).toEqual({
        file,
        diagnostics: count,
      });
    }

    const expected = fixtures.reduce((total, fixture) => total + fixture[2], 0);
    expect(diagnostics).toHaveLength(expected);
  },
  30_000,
);
