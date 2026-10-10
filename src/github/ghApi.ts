export type GhRun =
  | { kind: 'missing' }
  | { kind: 'exited'; exitCode: number; stdout: string; stderr: string };

export interface GitHubEffects {
  runGh: (args: readonly string[], signal: AbortSignal) => Promise<GhRun>;
  now: () => Date;
}

export type GitHubFailure =
  | { kind: 'ghMissing' }
  | { kind: 'notSignedIn' }
  | { kind: 'rateLimited'; resetAt: Date }
  | { kind: 'requestFailed'; status: number | null; message: string }
  | { kind: 'invalidResponse'; message: string };

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; failure: GitHubFailure };

export interface GhResponse {
  status: number;
  headers: ReadonlyMap<string, string>;
  body: unknown;
}

interface ParsedHttp {
  status: number;
  headers: Map<string, string>;
  bodyText: string;
}

const notSignedInExitCode = 4;
const okStatusMin = 200;
const okStatusMax = 300;
const notModifiedStatus = 304;
const forbiddenStatus = 403;
const tooManyRequestsStatus = 429;
const millisecondsPerSecond = 1000;
const fallbackDelaySeconds = 60;

export const createGhRunner = (): GitHubEffects['runGh'] => async (args, signal) => {
  const executable = Bun.which('gh', { PATH: Bun.env.PATH ?? '' });

  if (executable === null) {
    return { kind: 'missing' };
  }

  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

  try {
    child = Bun.spawn([executable, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    });
  } catch {
    return { kind: 'missing' };
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { kind: 'exited', exitCode, stdout, stderr };
};

const fail = (failure: GitHubFailure): { ok: false; failure: GitHubFailure } => ({
  ok: false,
  failure,
});

const parseHttp = (stdout: string): ParsedHttp | null => {
  const separator = /\r?\n\r?\n/.exec(stdout);
  const head = separator === null ? stdout : stdout.slice(0, separator.index);
  const bodyText = separator === null ? '' : stdout.slice(separator.index + separator[0].length);
  const [statusLine = '', ...headerLines] = head.split(/\r?\n/);
  const statusMatch = /^HTTP\/\S+\s+(\d{3})\b/.exec(statusLine);

  if (statusMatch === null) {
    return null;
  }

  const headers = new Map<string, string>();

  for (const line of headerLines) {
    const colon = line.indexOf(':');

    if (colon <= 0) {
      return null;
    }

    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }

  return { status: Number(statusMatch[1]), headers, bodyText };
};

const readBodyMessage = (bodyText: string): string | null => {
  try {
    const body: unknown = JSON.parse(bodyText);

    if (typeof body === 'object' && body !== null && 'message' in body) {
      return String(body.message);
    }
  } catch {
    // The body is not JSON, so there is no message.
  }

  return null;
};

const readErrorMessage = (parsed: ParsedHttp): string =>
  readBodyMessage(parsed.bodyText) ?? `HTTP ${parsed.status}`;

const isSecondaryLimit = (parsed: ParsedHttp): boolean => {
  if (parsed.status === tooManyRequestsStatus) {
    return true;
  }

  const message = readBodyMessage(parsed.bodyText);

  return parsed.status === forbiddenStatus && /secondary rate limit/i.test(message ?? '');
};

const findResetAt = (parsed: ParsedHttp, now: Date): Date | null => {
  const limited = parsed.status === forbiddenStatus || parsed.status === tooManyRequestsStatus;

  if (!limited) {
    return null;
  }

  const reset = Number(parsed.headers.get('x-ratelimit-reset'));
  const exhausted = parsed.headers.get('x-ratelimit-remaining') === '0';

  if (exhausted && Number.isFinite(reset)) {
    return new Date(reset * millisecondsPerSecond);
  }

  const retryAfter = parsed.headers.get('retry-after');
  const delaySeconds = retryAfter === undefined ? Number.NaN : Number(retryAfter);

  if (Number.isFinite(delaySeconds)) {
    return new Date(now.getTime() + delaySeconds * millisecondsPerSecond);
  }

  if (isSecondaryLimit(parsed)) {
    return new Date(now.getTime() + fallbackDelaySeconds * millisecondsPerSecond);
  }

  return null;
};

const parseBody = (bodyText: string): { ok: true; body: unknown } | { ok: false } => {
  if (bodyText.trim() === '') {
    return { ok: true, body: null };
  }

  try {
    const body: unknown = JSON.parse(bodyText);

    return { ok: true, body };
  } catch {
    return { ok: false };
  }
};

const readStatusFailure = (parsed: ParsedHttp, now: Date): GitHubFailure => {
  const resetAt = findResetAt(parsed, now);

  if (resetAt !== null) {
    return { kind: 'rateLimited', resetAt };
  }

  return { kind: 'requestFailed', status: parsed.status, message: readErrorMessage(parsed) };
};

export const requestGh = async (
  effects: GitHubEffects,
  endpoint: string,
  signal: AbortSignal,
  etag: string | null = null,
): Promise<GitHubResult<GhResponse>> => {
  const conditional = etag === null ? [] : ['-H', `If-None-Match: ${etag}`];
  const run = await effects.runGh(['api', '--include', ...conditional, endpoint], signal);

  if (run.kind === 'missing') {
    return fail({ kind: 'ghMissing' });
  }

  const parsed = parseHttp(run.stdout);

  if (parsed === null) {
    if (run.exitCode === notSignedInExitCode && run.stdout.trim() === '') {
      return fail({ kind: 'notSignedIn' });
    }

    if (run.exitCode !== 0) {
      return fail({ kind: 'requestFailed', status: null, message: run.stderr.trim() });
    }

    return fail({ kind: 'invalidResponse', message: 'Output is not an HTTP response' });
  }

  const isOkStatus = parsed.status >= okStatusMin && parsed.status < okStatusMax;
  const succeeded = isOkStatus || parsed.status === notModifiedStatus;

  if (!succeeded) {
    return fail(readStatusFailure(parsed, effects.now()));
  }

  const body = parseBody(parsed.bodyText);

  if (!body.ok) {
    return fail({ kind: 'invalidResponse', message: 'Response body is not JSON' });
  }

  return { ok: true, value: { status: parsed.status, headers: parsed.headers, body: body.body } };
};
