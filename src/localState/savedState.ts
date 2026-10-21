import { readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { Grouping, ThreadId } from '../work/work.ts';
import { groupings, toThreadId } from '../work/work.ts';

interface LocalStateFile {
  grouping: Grouping;
  done: ReadonlyMap<string, ReadonlyMap<ThreadId, string>>;
  seen: ReadonlyMap<string, ReadonlyMap<ThreadId, string>>;
}

export type StateLoad =
  | { kind: 'missing' }
  | { kind: 'loaded'; state: LocalStateFile }
  | { kind: 'invalid'; path: string; reason: string }
  | { kind: 'newer'; path: string; version: number };

export interface StateWriterEffects {
  makeDirectory: (directory: string, mode: number) => Promise<void>;
  openFile: (path: string, mode: number) => Promise<FileHandle>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

interface StateWriteFailure {
  reason: string;
  path: string;
}

export interface StateWriterOptions {
  onFailure: (failure: StateWriteFailure) => void;
  onSaved: () => void;
}

export interface StateWriter {
  save: (state: LocalStateFile) => void;
  flush: () => Promise<void>;
}

const ownerDirectoryMode = 0o700;
const ownerFileMode = 0o600;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stateFileName = 'state.json';

const plainReasons: Record<string, string> = {
  EACCES: 'Permission denied',
  EPERM: 'Permission denied',
  ENOSPC: 'Disk full',
  EROFS: 'Read-only file system',
};

const describeWriteError = (error: unknown): string => {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const plain = typeof code === 'string' ? plainReasons[code] : undefined;

  return plain ?? describeError(error);
};

export const stateVersion = 3;

const accountRecordsBody = z.record(z.string().min(1), z.record(z.string().min(1), z.string()));

const seenRecordsBody = z.record(
  z.string().min(1),
  z.record(z.string().min(1), z.iso.datetime({ offset: true })),
);

const stateBody = z.object({
  version: z.literal(stateVersion),
  grouping: z.enum(groupings),
  done: accountRecordsBody,
  seen: seenRecordsBody,
});

const versionTwoBody = z.object({
  version: z.literal(2),
  grouping: z.enum(groupings),
  done: accountRecordsBody,
});

const versionOneBody = z.object({
  version: z.literal(1),
  grouping: z.enum(groupings),
});

const versionProbe = z.object({ version: z.number().int().positive() });

const defaultStateWriterEffects: StateWriterEffects = {
  makeDirectory: async (directory, mode) => {
    await mkdir(directory, { recursive: true, mode });
  },
  openFile: (path, mode) => open(path, 'wx', mode),
  rename,
  remove: (path) => rm(path, { force: true }),
};

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const stateDirectory = (environment: Record<string, string | undefined>): string | null => {
  const stateHome = environment['XDG_STATE_HOME'];

  if (stateHome !== undefined && stateHome !== '') {
    return join(stateHome, 'mergit');
  }

  const home = environment['HOME'];

  if (home !== undefined && home !== '') {
    return join(home, '.local', 'state', 'mergit');
  }

  return null;
};

const toAccountMaps = (
  accounts: Record<string, Record<string, string>>,
): Map<string, Map<ThreadId, string>> =>
  new Map(
    Object.entries(accounts).map(([account, records]) => [
      account,
      new Map(
        Object.entries(records).map(([threadId, updatedAt]) => [toThreadId(threadId), updatedAt]),
      ),
    ]),
  );

const toAccountRecords = (
  accounts: ReadonlyMap<string, ReadonlyMap<ThreadId, string>>,
): Record<string, Record<string, string>> =>
  Object.fromEntries(
    [...accounts].map(([account, records]) => [account, Object.fromEntries(records)]),
  );

export const loadState = (directory: string): StateLoad => {
  const path = join(directory, stateFileName);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return { kind: 'missing' };
    }

    return { kind: 'invalid', path, reason: describeError(error) };
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (error) {
    return { kind: 'invalid', path, reason: describeError(error) };
  }

  const probe = versionProbe.safeParse(json);

  if (probe.success && probe.data.version > stateVersion) {
    return { kind: 'newer', path, version: probe.data.version };
  }

  const migrated = versionOneBody.safeParse(json);

  if (migrated.success) {
    return {
      kind: 'loaded',
      state: { grouping: migrated.data.grouping, done: new Map(), seen: new Map() },
    };
  }

  const versionTwo = versionTwoBody.safeParse(json);

  if (versionTwo.success) {
    return {
      kind: 'loaded',
      state: {
        grouping: versionTwo.data.grouping,
        done: toAccountMaps(versionTwo.data.done),
        seen: new Map(),
      },
    };
  }

  const body = stateBody.safeParse(json);

  if (!body.success) {
    return { kind: 'invalid', path, reason: 'The file does not have the shape Mergit saves.' };
  }

  return {
    kind: 'loaded',
    state: {
      grouping: body.data.grouping,
      done: toAccountMaps(body.data.done),
      seen: toAccountMaps(body.data.seen),
    },
  };
};

const writeStateFile = async (
  effects: StateWriterEffects,
  directory: string,
  state: LocalStateFile,
): Promise<{ ok: true } | { ok: false; error: unknown }> => {
  const temporaryPath = join(directory, `${stateFileName}.${crypto.randomUUID()}.tmp`);

  const done = toAccountRecords(state.done);
  const seen = toAccountRecords(state.seen);

  const body = `${JSON.stringify({ version: stateVersion, grouping: state.grouping, done, seen })}\n`;

  try {
    await effects.makeDirectory(directory, ownerDirectoryMode);

    const handle = await effects.openFile(temporaryPath, ownerFileMode);

    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await effects.rename(temporaryPath, join(directory, stateFileName));

    return { ok: true };
  } catch (error) {
    await effects.remove(temporaryPath).catch(() => undefined);

    return { ok: false, error };
  }
};

export const createStateWriter = (
  directory: string,
  options: StateWriterOptions,
  effects: StateWriterEffects = defaultStateWriterEffects,
): StateWriter => {
  let pending: LocalStateFile | null = null;
  let running: Promise<void> | null = null;

  const hasPending = () => pending !== null;

  const drain = async (): Promise<void> => {
    const state = pending;

    if (state === null) {
      running = null;

      return;
    }

    pending = null;

    const written = await writeStateFile(effects, directory, state);

    if (!written.ok) {
      options.onFailure({
        reason: describeWriteError(written.error),
        path: join(directory, stateFileName),
      });
    } else if (!hasPending()) {
      options.onSaved();
    }

    return drain();
  };

  return {
    save: (state) => {
      pending = state;
      running ??= drain();
    },
    flush: async () => {
      await running;
    },
  };
};
