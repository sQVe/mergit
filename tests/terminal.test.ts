import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const makeThread = (id: string, title: string, updatedAt = '2026-10-01T00:00:00Z'): object => ({
  id,
  unread: true,
  reason: 'subscribed',
  updated_at: updatedAt,
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
    '/user)',
    `  printf 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n%s' '{"login":"octocat"}'`,
    '  ;;',
    '*page=2*)',
    `  printf 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\netag: "page2"\\r\\n\\r\\n%s' '${JSON.stringify([makeThread('2', 'Second page thread')])}'`,
    '  ;;',
    '*)',
    `  printf 'HTTP/2.0 200 OK\\r\\netag: "page1"\\r\\nlink: <https://api.github.com/notifications?all=true&per_page=50&page=2>; rel="next"\\r\\n\\r\\n%s' '${JSON.stringify([makeThread('1', 'First page thread')])}'`,
    '  ;;',
    'esac',
  ].join('\n'),
);

const makeDoneFeedScript = (logPath: string, alphaUpdatedAt: string): string => {
  const feed = JSON.stringify([
    makeThread('1', 'Alpha thread', alphaUpdatedAt),
    makeThread('2', 'Beta thread', '2026-10-01T00:00:00Z'),
  ]);

  return makeFakeGhScript(
    [
      'case "$*" in',
      '*"--method DELETE"*)',
      `  printf '%s\\n' "$*" >> '${logPath}'`,
      "  printf 'HTTP/2.0 205 Reset Content\\r\\n\\r\\n'",
      '  exit 0',
      '  ;;',
      '*If-None-Match*)',
      "  printf 'HTTP/2.0 304 Not Modified\\r\\n\\r\\n'",
      '  exit 0',
      '  ;;',
      'esac',
      'case "$3" in',
      '/user)',
      `  printf 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n%s' '{"login":"octocat"}'`,
      '  ;;',
      '*)',
      `  printf 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\netag: "page1"\\r\\n\\r\\n%s' '${feed}'`,
      '  ;;',
      'esac',
    ].join('\n'),
  );
};

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

const startZeta = (binDirectory: string, stateHome: string = makeBinDirectory()): Child => {
  let output = '';
  const decoder = new TextDecoder();

  const processHandle = Bun.spawn([process.execPath, 'run', 'start'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: {
      ...process.env,
      PATH: binDirectory,
      TERM: 'xterm-256color',
      XDG_CACHE_HOME: makeBinDirectory(),
      XDG_STATE_HOME: stateHome,
    },
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

const startWithGh = (script: string, stateHome?: string): Child => {
  const directory = makeBinDirectory();

  installFakeGh(directory, script);

  return startZeta(directory, stateHome);
};

const stateFilePath = (stateHome: string): string => join(stateHome, 'zeta', 'state.json');

const writeStateFile = (stateHome: string, content: string): string => {
  const path = stateFilePath(stateHome);

  mkdirSync(join(stateHome, 'zeta'), { recursive: true });
  writeFileSync(path, content);

  return path;
};

const pressAndQuit = async (child: Child, ready: string, keys: string): Promise<void> => {
  await waitForOutput(child, ready);
  child.processHandle.terminal?.write(keys);
  await Bun.sleep(200);
  child.processHandle.terminal?.write('q');

  expect(await waitForExit(child)).toBe(0);
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

test('a newer state file stops startup with its path and stays unchanged', async () => {
  const stateHome = makeBinDirectory();
  const content = '{ "version": 4, "grouping": "type" }';
  const path = writeStateFile(stateHome, content);
  const child = startWithGh(twoPagesScript, stateHome);

  expect(await waitForExit(child)).toBe(1);
  expect(child.getOutput()).toContain(path);
  expect(readFileSync(path, 'utf8')).toBe(content);
}, 30_000);

test('the chosen grouping is saved at quit and restored on the next start', async () => {
  const stateHome = makeBinDirectory();

  await pressAndQuit(startWithGh(twoPagesScript, stateHome), '? help', 's');

  expect(readFileSync(stateFilePath(stateHome), 'utf8')).toContain('"grouping":"type"');

  await pressAndQuit(startWithGh(twoPagesScript, stateHome), '? help', 's');

  expect(readFileSync(stateFilePath(stateHome), 'utf8')).toContain('"grouping":"none"');
}, 60_000);

test('an invalid state file shows a warning and is never written', async () => {
  const stateHome = makeBinDirectory();
  const content = '{ not json';
  const path = writeStateFile(stateHome, content);
  const child = startWithGh(twoPagesScript, stateHome);

  await pressAndQuit(child, 'will not save', 's');

  expect(readFileSync(path, 'utf8')).toBe(content);
}, 30_000);

const makeDoneLogPath = (): string => join(makeBinDirectory(), 'deletes.log');

const readDeleteLog = (logPath: string): string[] =>
  existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];

const selectFirstThread = async (child: Child): Promise<void> => {
  await waitForOutput(child, 'Alpha thread');
  child.processHandle.terminal?.write('jj');
  await Bun.sleep(200);
};

test('pressing d and quitting at once sends one DELETE and saves the done record', async () => {
  const stateHome = makeBinDirectory();
  const logPath = makeDoneLogPath();
  const child = startWithGh(makeDoneFeedScript(logPath, '2026-10-02T00:00:00Z'), stateHome);

  await selectFirstThread(child);
  child.processHandle.terminal?.write('d');
  child.processHandle.terminal?.write('q');

  expect(await waitForExit(child)).toBe(0);

  const deletes = readDeleteLog(logPath);

  expect(deletes).toHaveLength(1);
  expect(deletes[0]).toContain('/notifications/threads/1');

  expect(readFileSync(stateFilePath(stateHome), 'utf8')).toContain(
    '"done":{"github.com/octocat":{"1":"2026-10-02T00:00:00Z"}}',
  );
}, 30_000);

test('a done thread stays hidden until the feed returns a newer updated_at', async () => {
  const stateHome = makeBinDirectory();
  const logPath = makeDoneLogPath();
  const sameScript = makeDoneFeedScript(logPath, '2026-10-02T00:00:00Z');
  const first = startWithGh(sameScript, stateHome);

  await selectFirstThread(first);
  first.processHandle.terminal?.write('d');
  first.processHandle.terminal?.write('q');
  expect(await waitForExit(first)).toBe(0);

  const same = startWithGh(sameScript, stateHome);

  await waitForOutput(same, 'Beta thread');
  expect(same.getOutput()).not.toContain('Alpha thread');
  same.processHandle.terminal?.write('q');
  expect(await waitForExit(same)).toBe(0);

  const newer = startWithGh(makeDoneFeedScript(logPath, '2026-10-03T00:00:00Z'), stateHome);

  await waitForOutput(newer, 'Alpha thread');
}, 60_000);

test('pressing d and then u before quitting sends no DELETE', async () => {
  const stateHome = makeBinDirectory();
  const logPath = makeDoneLogPath();
  const child = startWithGh(makeDoneFeedScript(logPath, '2026-10-02T00:00:00Z'), stateHome);

  await selectFirstThread(child);
  child.processHandle.terminal?.write('d');
  await Bun.sleep(200);
  child.processHandle.terminal?.write('u');
  await Bun.sleep(200);
  child.processHandle.terminal?.write('q');

  expect(await waitForExit(child)).toBe(0);
  expect(readDeleteLog(logPath)).toEqual([]);
}, 30_000);
