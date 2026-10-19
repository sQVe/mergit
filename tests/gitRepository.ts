import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

const runGit = (directory: string, args: string[]) =>
  promisify(execFile)('git', args, { cwd: directory });

export const createTemporaryRepository = async (
  registerCleanup: RegisterCleanup,
  prefix = 'phi-repository-',
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  registerCleanup(() => rm(directory, { recursive: true, force: true }));

  await runGit(directory, ['init', '--quiet', '--initial-branch=main']);
  await runGit(directory, ['config', 'user.name', 'Phi Test']);
  await runGit(directory, ['config', 'user.email', 'phi@example.com']);
  await runGit(directory, ['config', 'commit.gpgsign', 'false']);

  return directory;
};
