import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob, relative, resolve } from 'node:path';

import { Instrumenter } from '@stryker-mutator/instrumenter';
import { noopLogger } from '@stryker-mutator/util';
import { z } from 'zod';

import { enabledIgnorers } from './mutationIgnorePolicy.ts';
import { mutationIgnorer } from './mutationIgnorer.ts';
import { buildMutationReport, failedMutationReport } from './mutationReport.ts';
import type { Mutant, MutationMode, MutationOutcome, StrykerReport } from './mutationReport.ts';
import {
  auditScope,
  changedLinesDiffArguments,
  changedScope,
  countedMutants,
  fitCap,
  groupByFolder,
  isProductionFile,
  mergedConfig,
  mutateConfigError,
  mutatePatterns,
  parseCommand,
  rejectedAuditPaths,
  unitTestFiles,
  unreportedFiles,
} from './mutationScope.ts';
import type { Command, FileScope } from './mutationScope.ts';

const configSchema = z.looseObject({
  mutate: z.array(z.string()),
  thresholds: z.record(z.string(), z.unknown()).optional(),
  mutator: z.looseObject({ excludedMutations: z.array(z.string()).optional() }).optional(),
  ignorers: z.array(z.string()).optional(),
  bun: z.record(z.string(), z.unknown()).optional(),
  sameFolderTests: z.boolean().optional(),
});

type StrykerConfig = z.output<typeof configSchema>;

const reportSchema = z.object({
  files: z.record(
    z.string(),
    z.object({
      mutants: z.array(
        z.object({
          mutatorName: z.string(),
          replacement: z.string(),
          status: z.string(),
          location: z.object({
            start: z.object({ line: z.number(), column: z.number() }),
            end: z.object({ line: z.number(), column: z.number() }),
          }),
        }),
      ),
    }),
  ),
});

const maxGitOutput = Number.POSITIVE_INFINITY;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: maxGitOutput });

const readConfig = (path: string): StrykerConfig => {
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));

  if (!parsed.success) {
    throw new Error(`${path} is not a usable Stryker config: ${z.prettifyError(parsed.error)}`);
  }

  const problem = mutateConfigError(parsed.data.mutate, path);

  if (problem !== undefined) {
    throw new Error(problem);
  }

  return parsed.data;
};

const changedFiles = (root: string, base: string, isProduction: (path: string) => boolean) => {
  const diff = git(root, ...changedLinesDiffArguments(base));
  const untrackedOutput = git(root, 'ls-files', '-z', '--others', '--exclude-standard');
  const untracked = untrackedOutput.split('\0').filter((path) => path !== '');

  return changedScope(diff, untracked, isProduction);
};

const auditFiles = (
  root: string,
  paths: readonly string[],
  isProduction: (path: string) => boolean,
) => {
  const relativePaths = paths.map((path) => relative(root, resolve(path)));
  const rejected = rejectedAuditPaths(relativePaths, isProduction);

  if (rejected.length > 0) {
    throw new Error(`Not production code in the config's mutate globs: ${rejected.join(', ')}`);
  }

  return auditScope(relativePaths, isProduction);
};

const wholeFileRanges = (scope: FileScope) =>
  scope.ranges === undefined
    ? true
    : scope.ranges.map(({ start, end }) => ({
        start: { line: start - 1, column: 0 },
        end: { line: end - 1, column: Number.MAX_SAFE_INTEGER },
      }));

const instrumentScope = async (root: string, scope: FileScope, config: StrykerConfig) => {
  const instrumenter = new Instrumenter(noopLogger);
  const ignorers = enabledIgnorers(config.ignorers, mutationIgnorer);
  const content = readFileSync(join(root, scope.path), 'utf8');

  const result = await instrumenter.instrument(
    [{ name: scope.path, content, mutate: wholeFileRanges(scope) }],
    { plugins: null, excludedMutations: config.mutator?.excludedMutations ?? [], ignorers },
  );

  return result.mutants;
};

// The instrumenter counts lines and columns from 0, the report from 1.
const noCoverageMutants = (found: Awaited<ReturnType<typeof instrumentScope>>): Mutant[] =>
  found
    .filter(({ status }) => status !== 'Ignored')
    .map(({ mutatorName, replacement, location }) => ({
      mutatorName,
      replacement,
      status: 'NoCoverage',
      location: {
        start: { line: location.start.line + 1, column: location.start.column + 1 },
        end: { line: location.end.line + 1, column: location.end.column + 1 },
      },
    }));

// Stryker rejects options it does not know, so `sameFolderTests` stays out of its config.
const runStrykerOnce = (
  root: string,
  directory: string,
  config: StrykerConfig,
  scopes: FileScope[],
  testFiles?: string[],
) => {
  const reportPath = join(directory, 'mutation.json');
  const configPath = join(directory, 'stryker.config.json');
  const { sameFolderTests: _sameFolderTests, ...strykerConfig } = config;

  const withTests =
    testFiles === undefined
      ? strykerConfig
      : { ...strykerConfig, bun: { ...strykerConfig.bun, testFiles } };

  writeFileSync(
    configPath,
    JSON.stringify(
      mergedConfig(withTests, scopes.flatMap(mutatePatterns), reportPath),
      undefined,
      2,
    ),
  );

  const stryker = spawnSync(
    process.execPath,
    [join(root, 'node_modules/.bin/stryker'), 'run', configPath],
    { cwd: root, stdio: ['ignore', 2, 2] },
  );

  if (stryker.status !== 0) {
    throw new Error(`Stryker exited with status ${stryker.status}. See its output on stderr.`);
  }

  const parsed = reportSchema.safeParse(JSON.parse(readFileSync(reportPath, 'utf8')));

  if (!parsed.success) {
    throw new Error(`Stryker wrote an unusable report: ${z.prettifyError(parsed.error)}`);
  }

  return parsed.data.files;
};

// Runs Stryker once per folder, with only the unit tests of that folder. A folder with no unit test
// gets no run: all its mutants have no coverage.
const runStrykerPerFolder = (
  root: string,
  config: StrykerConfig,
  scopes: FileScope[],
  mutantsOf: Map<string, Awaited<ReturnType<typeof instrumentScope>>>,
): StrykerReport => {
  const directory = mkdtempSync(join(tmpdir(), 'mutation-'));
  const files: StrykerReport['files'] = {};

  try {
    for (const [folder, folderScopes] of groupByFolder(scopes)) {
      const testFiles = unitTestFiles(folder, readdirSync(join(root, folder)));

      if (testFiles.length > 0) {
        Object.assign(files, runStrykerOnce(root, directory, config, folderScopes, testFiles));

        continue;
      }

      for (const { path } of folderScopes) {
        files[path] = { mutants: noCoverageMutants(mutantsOf.get(path) ?? []) };
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  return { files };
};

// `sameFolderTests` off runs every unit test against each mutant in one Stryker run.
const runStryker = (
  root: string,
  config: StrykerConfig,
  scopes: FileScope[],
  mutantsOf: Map<string, Awaited<ReturnType<typeof instrumentScope>>>,
): StrykerReport => {
  if (config.sameFolderTests === true) {
    return runStrykerPerFolder(root, config, scopes, mutantsOf);
  }

  const directory = mkdtempSync(join(tmpdir(), 'mutation-'));

  try {
    return { files: runStrykerOnce(root, directory, config, scopes) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const readSources = (root: string, report: StrykerReport) =>
  Object.fromEntries(
    Object.keys(report.files).map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );

const mutate = async (command: Command): Promise<{ report: MutationOutcome; exitCode: number }> => {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const config = readConfig(resolve(root, command.configPath ?? 'stryker.config.json'));
  const isProduction = (path: string) => isProductionFile(path, config.mutate, matchesGlob);

  const scopes =
    command.mode === 'changed'
      ? changedFiles(root, command.base ?? 'HEAD', isProduction)
      : auditFiles(root, command.paths, isProduction);

  const mutantsOf = new Map<string, Awaited<ReturnType<typeof instrumentScope>>>();

  const counts = await Promise.all(
    scopes.map(async (scope) => {
      const found = await instrumentScope(root, scope, config);

      mutantsOf.set(scope.path, found);

      return { path: scope.path, mutants: countedMutants(found) };
    }),
  );

  const { run, unmutated } = fitCap(counts, command.maxMutants);
  const runScopes = scopes.filter(({ path }) => run.includes(path));

  const stryker =
    runScopes.length === 0 ? undefined : runStryker(root, config, runScopes, mutantsOf);

  const sources = stryker === undefined ? {} : readSources(root, stryker);

  const reportedPaths = Object.entries(stryker?.files ?? {})
    .filter(([, { mutants }]) => mutants.length > 0)
    .map(([path]) => path);

  const unreported = unreportedFiles(
    counts.filter(({ path }) => run.includes(path)),
    reportedPaths,
  );

  return buildMutationReport({
    mode: command.mode,
    ...(stryker === undefined ? {} : { stryker }),
    sources,
    unmutated: [...unmutated, ...unreported].toSorted(),
  });
};

const main = async () => {
  let result: { report: MutationOutcome; exitCode: number };
  let mode: MutationMode | null = null;

  try {
    const command = parseCommand(process.argv.slice(2));

    mode = command.mode;
    result = await mutate(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    result = { report: failedMutationReport(mode, message), exitCode: 1 };
  }

  process.stdout.write(`${JSON.stringify(result.report, undefined, 2)}\n`);
  process.exitCode = result.exitCode;
};

await main();
