import { expect, it, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MutationOutcome } from '../scripts/mutationReport.ts';
import { isProductionFile } from '../scripts/mutationScope.ts';
import { createTemporaryRepository } from './gitRepository.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/mutation.ts');

const baseConfig = {
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  tsconfigFile: 'stryker-no-tsconfig.json',
  checkers: [],
  fileLogLevel: 'off',
  concurrency: 1,
  tempDirName: '.stryker-tmp',
};

const writeFiles = async (directory: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
};

const createProject = async (config: Record<string, unknown>, files: Record<string, string>) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await symlink(join(root, 'node_modules'), join(repository, 'node_modules'));
  await writeFiles(repository, { 'stryker.config.json': JSON.stringify(config), ...files });

  return repository;
};

const runScript = (repository: string, args: string[], temporaryDirectory?: string) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(temporaryDirectory === undefined ? {} : { TMPDIR: temporaryDirectory }),
    },
  });

  // SAFETY: the script prints one MutationOutcome as JSON on stdout.
  const report = JSON.parse(result.stdout) as MutationOutcome;

  return { status: result.status, report };
};

const adder = 'export const add = (left: number, right: number) => left + right;\n';

it.each([
  { name: 'no mutate list', config: { ...baseConfig, mutate: undefined } },
  { name: 'an empty mutate list', config: { ...baseConfig, mutate: [] } },
  { name: 'a mutate list of only negated globs', config: { ...baseConfig, mutate: ['!src/a.ts'] } },
  { name: 'a mutate list with a non-string', config: { ...baseConfig, mutate: [1] } },
])('exits 1 with an error report for $name', async ({ config }) => {
  const repository = await createProject(config, { 'src/a.ts': adder });

  const { status, report } = runScript(repository, ['audit', 'src/a.ts']);

  expect(status).toBe(1);
  expect(report.status).toBe('error');
  expect(report.error).toContain('stryker.config.json');
  expect(report.survivors).toEqual([]);
});

it('exits 1 with an error report and removes its temporary directory when Stryker fails', async () => {
  const repository = await createProject(
    { ...baseConfig, plugins: ['./missing-plugin.js'] },
    {
      'src/a.ts': adder,
      'src/a.test.ts':
        "import { it } from 'bun:test';\nimport { add } from './a.ts';\n\nit('adds', () => add(1, 2));\n",
    },
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'phi-mutation-tmp-'));
  onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const { status, report } = runScript(repository, ['audit', 'src/a.ts'], temporaryDirectory);

  expect(status).toBe(1);
  expect(report.status).toBe('error');
  expect(report.error).toContain('Stryker exited with status');
  expect(await readdir(temporaryDirectory)).toEqual([]);
});

const strongTestInOtherFolder = {
  'src/a/a.ts': adder,
  'src/a/a.test.ts':
    "import { it } from 'bun:test';\nimport { add } from './a.ts';\n\nit('runs', () => {\n  add(1, 2);\n});\n",
  'src/b/b.test.ts':
    "import { expect, it } from 'bun:test';\nimport { add } from '../a/a.ts';\n\nit('adds', () => expect(add(1, 2)).toBe(3));\n",
};

it('lets a test in another folder kill a mutant when sameFolderTests is off', async () => {
  const repository = await createProject(
    { ...baseConfig, plugins: ['@hughescr/stryker-bun-runner'] },
    strongTestInOtherFolder,
  );

  const { status, report } = runScript(repository, ['audit', 'src/a/a.ts']);

  expect(status).toBe(0);
  expect(report.totals.killed).toBeGreaterThan(0);
  expect(report.survivors).toEqual([]);
});

it('covers a folder with no unit test by a test in another folder when sameFolderTests is off', async () => {
  const repository = await createProject(
    { ...baseConfig, plugins: ['@hughescr/stryker-bun-runner'] },
    {
      'src/a/a.ts': adder,
      'src/b/b.test.ts': strongTestInOtherFolder['src/b/b.test.ts'],
    },
  );

  const { status, report } = runScript(repository, ['audit', 'src/a/a.ts']);

  expect(status).toBe(0);
  expect(report.totals.killed).toBeGreaterThan(0);
  expect(report.totals.noCoverage).toBe(0);
});

it('reports no coverage in a folder with no unit test even when a test in another folder covers it when sameFolderTests is on', async () => {
  const repository = await createProject(
    { ...baseConfig, sameFolderTests: true },
    {
      'src/a/a.ts': adder,
      'src/b/b.test.ts':
        "import { expect, it } from 'bun:test';\nimport { add } from '../a/a.ts';\n\nit('adds', () => expect(add(1, 2)).toBe(3));\n",
    },
  );

  const { status, report } = runScript(repository, ['audit', 'src/a/a.ts']);

  expect(status).toBe(0);
  expect(report.totals.noCoverage).toBeGreaterThan(0);
  expect(report.totals.killed).toBe(0);
  expect(report.survivors.every(({ covered }) => !covered)).toBe(true);
});

it('does not let a test in another folder kill a mutant of a folder that has a weak unit test when sameFolderTests is on', async () => {
  const repository = await createProject(
    {
      ...baseConfig,
      sameFolderTests: true,
      plugins: ['@hughescr/stryker-bun-runner'],
      concurrency: 1,
    },
    {
      'src/a/a.ts': adder,
      'src/a/a.test.ts':
        "import { it } from 'bun:test';\nimport { add } from './a.ts';\n\nit('runs', () => {\n  add(1, 2);\n});\n",
      'src/b/b.test.ts':
        "import { expect, it } from 'bun:test';\nimport { add } from '../a/a.ts';\n\nit('adds', () => expect(add(1, 2)).toBe(3));\n",
    },
  );

  const { report } = runScript(repository, ['audit', 'src/a/a.ts']);

  expect(report.totals.killed).toBe(0);
  expect(report.survivors.some(({ covered }) => covered)).toBe(true);
});

it('treats a tsx production file as in scope and a tsx test file as out of scope in the repository config', async () => {
  const config = JSON.parse(await readFile(join(root, 'stryker.config.json'), 'utf8')) as {
    mutate: string[];
  };

  const inScope = (path: string) => isProductionFile(path, config.mutate, matchesGlob);

  expect(inScope('src/ui/workspaceList.tsx')).toBe(true);
  expect(inScope('src/ui/workspaceList.test.tsx')).toBe(false);
});

it('mutates an untracked production file in changed mode and reports it as uncovered', async () => {
  const repository = await createProject(
    { ...baseConfig, sameFolderTests: true },
    { 'README.md': 'base\n' },
  );

  const git = (...args: string[]) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' });

  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'base');
  await writeFiles(repository, { 'src/a/a.ts': adder });

  const { status, report } = runScript(repository, ['changed', 'HEAD']);

  expect(status).toBe(2);
  expect(report.status).toBe('survivors');
  expect(report.survivors.length).toBeGreaterThan(0);

  expect(report.survivors.every(({ file, covered }) => file === 'src/a/a.ts' && !covered)).toBe(
    true,
  );
});
