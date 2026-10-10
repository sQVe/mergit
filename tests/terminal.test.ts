import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Child {
  processHandle: Bun.Subprocess;
  getOutput: () => string;
}

const enterAlternateScreen = '\u001B[?1049h';
const leaveAlternateScreen = '\u001B[?1049l';
const showCursor = '\u001B[?25h';
const waitMilliseconds = 10_000;

const children: Child[] = [];
const directories: string[] = [];

const makeThread = (id: string, title: string): object => ({
  id,
  unread: true,
  reason: 'subscribed',
  updated_at: '2026-10-01T00:00:00Z',
  last_read_at: null,
  subject: {
    title,
    type: 'PullRequest',
    url: `https://api.github.com/repos/example/repo/pulls/${id}`,
  },
  repository: { full_name: 'example/repo' },
});

const makeFakeGhScript = (body: string): string => `#!/bin/sh\n${body}\n`;

const twoPagesScript = makeFakeGhScript(
  [
    'case "$*" in',
    '*If-None-Match*)',
    "  printf 'HTTP/2.0 304 Not Modified\\r\\n\\r\\n'",
    '  exit 0',
    '  ;;',
    'esac',
    'case "$3" in',
    '*page=2*)',
    `  printf 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\netag: "page2"\\r\\n\\r\\n%s' '${JSON.stringify([makeThread('2', 'Second page thread')])}'`,
    '  ;;',
    '*)',
    `  printf 'HTTP/2.0 200 OK\\r\\netag: "page1"\\r\\nlink: <https://api.github.com/notifications?all=true&per_page=50&page=2>; rel="next"\\r\\n\\r\\n%s' '${JSON.stringify([makeThread('1', 'First page thread')])}'`,
    '  ;;',
    'esac',
  ].join('\n'),
);

const notSignedInScript = makeFakeGhScript('exit 4');

const makeBinDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'zeta-bin-'));

  directories.push(directory);

  return directory;
};

const installFakeGh = (directory: string, script: string): void => {
  const path = join(directory, 'gh');

  writeFileSync(path, script);
  chmodSync(path, 0o755);
};

const startZeta = (binDirectory: string): Child => {
  let output = '';
  const decoder = new TextDecoder();

  const processHandle = Bun.spawn([process.execPath, 'run', 'start'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...process.env, PATH: binDirectory, TERM: 'xterm-256color' },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
    },
  });

  const child: Child = { processHandle, getOutput: () => output };

  children.push(child);

  return child;
};

afterEach(() => {
  for (const child of children.splice(0)) {
    child.processHandle.kill('SIGKILL');
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const waitForOutput = async (child: Child, text: string): Promise<void> => {
  const deadline = Date.now() + waitMilliseconds;

  while (!child.getOutput().includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${JSON.stringify(text)}.`);
    }

    await Bun.sleep(25);
  }
};

const waitForExit = async (child: Child): Promise<number> => {
  const timeout = Bun.sleep(waitMilliseconds).then(() => 'timeout' as const);
  const result = await Promise.race([child.processHandle.exited, timeout]);

  if (result === 'timeout') {
    throw new Error('Timed out waiting for Zeta to exit.');
  }

  return result;
};

const expectRestored = (output: string): void => {
  const enter = output.lastIndexOf(enterAlternateScreen);
  const leave = output.lastIndexOf(leaveAlternateScreen);

  expect(enter).toBeGreaterThan(-1);
  expect(leave).toBeGreaterThan(enter);
  expect(output.endsWith(showCursor)).toBe(true);
};

const startWithGh = (script: string): Child => {
  const directory = makeBinDirectory();

  installFakeGh(directory, script);

  return startZeta(directory);
};

test('Zeta shows every thread from both pages', async () => {
  const child = startWithGh(twoPagesScript);

  await waitForOutput(child, 'First page thread');
  await waitForOutput(child, 'Second page thread');
}, 30_000);

test('a missing gh shows the install notice, and r reads threads once gh exists', async () => {
  const directory = makeBinDirectory();
  const child = startZeta(directory);

  await waitForOutput(child, 'Install GitHub CLI from https://cli.github.com');
  expect(child.processHandle.killed).toBe(false);

  installFakeGh(directory, twoPagesScript);
  child.processHandle.terminal?.write('r');

  await waitForOutput(child, 'First page thread');
}, 30_000);

test('a signed-out gh shows the sign-in notice', async () => {
  const child = startWithGh(notSignedInScript);

  await waitForOutput(child, 'Run gh auth login');
}, 30_000);

test('q quits and restores the terminal', async () => {
  const child = startWithGh(twoPagesScript);

  await waitForOutput(child, '? help');
  child.processHandle.terminal?.write('q');

  expect(await waitForExit(child)).toBe(0);
  expectRestored(child.getOutput());
}, 30_000);

test('SIGINT quits and restores the terminal', async () => {
  const child = startWithGh(twoPagesScript);

  await waitForOutput(child, '? help');
  child.processHandle.kill('SIGINT');

  expect(await waitForExit(child)).toBe(0);
  expectRestored(child.getOutput());
}, 30_000);

test('Ctrl+C quits and restores the terminal', async () => {
  const child = startWithGh(twoPagesScript);

  await waitForOutput(child, '? help');
  child.processHandle.terminal?.write('\u0003');

  expect(await waitForExit(child)).toBe(0);
  expectRestored(child.getOutput());
}, 30_000);
