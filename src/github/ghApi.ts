import type { ReadableStreamDefaultReader } from 'node:stream/web';

import { z } from 'zod';

export type GhRun =
  | { kind: 'missing' }
  | { kind: 'exited'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'tooLarge'; limitBytes: number };

export interface GitHubEffects {
  runGh: (args: readonly string[], signal: AbortSignal) => Promise<GhRun>;
  now: () => Date;
  host: string;
}

export type GitHubFailure =
  | { kind: 'ghMissing' }
  | { kind: 'notSignedIn' }
  | { kind: 'rateLimited'; resetAt: Date }
  | { kind: 'requestFailed'; status: number | null; message: string }
  | { kind: 'invalidResponse'; message: string }
  | { kind: 'responseTooLarge'; limitBytes: number };

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; failure: GitHubFailure };

export interface GraphqlVariables {
  strings: Record<string, string>;
  integers: Record<string, number>;
}

export interface GhResponse {
  status: number;
  headers: ReadonlyMap<string, string>;
  body: unknown;
  bodyText: string;
}

interface ParsedHttp {
  status: number;
  headers: Map<string, string>;
  bodyText: string;
}

export const globalNodeIdHeader = 'X-Github-Next-Global-ID: 1';

export const graphqlErrorSchema = z.object({
  type: z.string().optional(),
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
});

export type GraphqlError = z.infer<typeof graphqlErrorSchema>;

const notSignedInExitCode = 4;
const okStatusMin = 200;
const okStatusMax = 300;
const notModifiedStatus = 304;
const forbiddenStatus = 403;
const tooManyRequestsStatus = 429;
const millisecondsPerSecond = 1000;
const fallbackDelaySeconds = 60;
const rateLimitedType = 'RATE_LIMITED';

const ghOutputLimitBytes = 4_194_304;

const readCapped = async (
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  limitBytes: number,
  onOverLimit: () => Promise<void>,
): Promise<Uint8Array<ArrayBuffer>[] | null> => {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a stream gives its chunks one at a time
    const { done, value } = await reader.read();

    if (done) {
      return chunks;
    }

    total += value.byteLength;

    if (total > limitBytes) {
      break;
    }

    chunks.push(value);
  }

  await onOverLimit();

  return null;
};

const runGh = async (
  args: readonly string[],
  signal: AbortSignal,
  limitBytes: number,
): Promise<GhRun> => {
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

  const readers = [child.stdout.getReader(), child.stderr.getReader()];

  const stopReading = async (): Promise<void> => {
    child.kill('SIGKILL');
    await Promise.all(readers.map((reader) => reader.cancel()));
  };

  const [stdoutChunks, stderrChunks] = await Promise.all(
    readers.map((reader) => readCapped(reader, limitBytes, stopReading)),
  );

  const exitCode = await child.exited;

  if (stdoutChunks === null || stderrChunks === null) {
    return { kind: 'tooLarge', limitBytes };
  }

  const [stdout, stderr] = await Promise.all([
    new Blob(stdoutChunks).text(),
    new Blob(stderrChunks).text(),
  ]);

  return { kind: 'exited', exitCode, stdout, stderr };
};

export const createGhRunner =
  (limitBytes = ghOutputLimitBytes): GitHubEffects['runGh'] =>
  (args, signal) =>
    runGh(args, signal, limitBytes);

const fail = (failure: GitHubFailure): { ok: false; failure: GitHubFailure } => ({
  ok: false,
  failure,
});

export const readGraphqlFailure = (error: GraphqlError, response: GhResponse): GitHubFailure => {
  const reset = Number(response.headers.get('x-ratelimit-reset'));

  if (error.type === rateLimitedType && Number.isFinite(reset)) {
    return { kind: 'rateLimited', resetAt: new Date(reset * millisecondsPerSecond) };
  }

  return {
    kind: 'requestFailed',
    status: response.status,
    message: error.message,
  };
};

export const invalid = (message: string): { ok: false; failure: GitHubFailure } => ({
  ok: false,
  failure: { kind: 'invalidResponse', message },
});

export const presentNodes = <T>(nodes: (T | null)[]): T[] =>
  nodes.filter((node): node is T => node !== null);

export const viewerSchema = z.object({ id: z.string().min(1), login: z.string().min(1) });

const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(graphqlErrorSchema).optional(),
});

const notFoundType = 'NOT_FOUND';

const isFailedError = (error: GraphqlError): boolean => error.type !== notFoundType;

const readErrorsFailure = (errors: GraphqlError[], response: GhResponse): GitHubFailure | null => {
  const failures = errors.filter(isFailedError).map((error) => readGraphqlFailure(error, response));

  return failures.find((failure) => failure.kind === 'rateLimited') ?? failures[0] ?? null;
};

export const readGraphqlData = (response: GhResponse): GitHubResult<unknown> => {
  const envelope = graphqlEnvelopeSchema.safeParse(response.body);

  if (!envelope.success) {
    return invalid(envelope.error.message);
  }

  const errorsFailure = readErrorsFailure(envelope.data.errors ?? [], response);

  if (errorsFailure !== null) {
    return { ok: false, failure: errorsFailure };
  }

  return { ok: true, value: envelope.data.data };
};

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

const runApi = async (
  effects: GitHubEffects,
  args: readonly string[],
  signal: AbortSignal,
): Promise<GitHubResult<GhResponse>> => {
  const run = await effects.runGh(args, signal);

  if (run.kind === 'missing') {
    return fail({ kind: 'ghMissing' });
  }

  if (run.kind === 'tooLarge') {
    return fail({ kind: 'responseTooLarge', limitBytes: run.limitBytes });
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

  return {
    ok: true,
    value: {
      status: parsed.status,
      headers: parsed.headers,
      body: body.body,
      bodyText: parsed.bodyText,
    },
  };
};

export const requestGh = (
  effects: GitHubEffects,
  endpoint: string,
  signal: AbortSignal,
  etag: string | null = null,
  headers: readonly string[] = [],
): Promise<GitHubResult<GhResponse>> => {
  const conditional = etag === null ? [] : ['-H', `If-None-Match: ${etag}`];
  const extra = headers.flatMap((header) => ['-H', header]);

  return runApi(
    effects,
    ['api', '--hostname', effects.host, '--include', ...conditional, ...extra, endpoint],
    signal,
  );
};

export const requestGhDelete = (
  effects: GitHubEffects,
  endpoint: string,
  signal: AbortSignal,
): Promise<GitHubResult<GhResponse>> =>
  runApi(
    effects,
    ['api', '--hostname', effects.host, '--include', '--method', 'DELETE', endpoint],
    signal,
  );

export const requestGraphql = (
  effects: GitHubEffects,
  query: string,
  variables: GraphqlVariables,
  signal: AbortSignal,
  headers: readonly string[] = [],
): Promise<GitHubResult<GhResponse>> => {
  const strings = Object.entries(variables.strings).flatMap(([name, value]) => [
    '-f',
    `${name}=${value}`,
  ]);

  const integers = Object.entries(variables.integers).flatMap(([name, value]) => [
    '-F',
    `${name}=${value}`,
  ]);

  const extra = headers.flatMap((header) => ['-H', header]);

  return runApi(
    effects,
    [
      'api',
      'graphql',
      '--hostname',
      effects.host,
      '--include',
      ...extra,
      '-f',
      `query=${query}`,
      ...strings,
      ...integers,
    ],
    signal,
  );
};
