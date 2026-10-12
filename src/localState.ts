import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { ViewerLogin } from './work/work.ts';
import { toViewerLogin } from './work/work.ts';

interface LocalPage {
  path: string;
  etag: string | null;
  next: string | null;
  body: string;
}

export interface LocalSnapshot {
  host: string;
  login: ViewerLogin;
  viewerEtag: string | null;
  savedAt: Date;
  pages: LocalPage[];
}

interface LocalStateFailure {
  message: string;
}

export type LocalStateResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: LocalStateFailure };

type Attempt<T> =
  | { kind: 'done'; value: T }
  | { kind: 'corrupt'; message: string }
  | { kind: 'failed'; message: string };

const pageRow = z.object({
  path: z.string(),
  etag: z.string().nullable(),
  next: z.string().nullable(),
  body: z.string(),
});

const lastRow = z.object({
  host: z.string(),
  login: z.string(),
  viewerEtag: z.string().nullable(),
  savedAt: z.number(),
});

const busyTimeoutMilliseconds = 250;
const corruptionCodes = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB']);

const ownerDirectoryMode = 0o700;
const ownerFileMode = 0o600;
const databaseSuffixes = ['', '-journal', '-wal', '-shm'];

const schemaVersion = 2;

const schema = `
  CREATE TABLE IF NOT EXISTS last (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT NOT NULL,
    login TEXT NOT NULL,
    viewerEtag TEXT,
    savedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    host TEXT NOT NULL,
    login TEXT NOT NULL,
    position INTEGER NOT NULL,
    path TEXT NOT NULL,
    etag TEXT,
    next TEXT,
    body TEXT NOT NULL,
    PRIMARY KEY (host, login, position)
  );
`;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fail = (error: unknown): { ok: false; failure: LocalStateFailure } => ({
  ok: false,
  failure: { message: describeError(error) },
});

export const cacheDirectory = (environment: Record<string, string | undefined>): string | null => {
  const cacheHome = environment['XDG_CACHE_HOME'];

  if (cacheHome !== undefined && cacheHome !== '') {
    return join(cacheHome, 'zeta');
  }

  const home = environment['HOME'];

  if (home !== undefined && home !== '') {
    return join(home, '.cache', 'zeta');
  }

  return null;
};

const removeDatabaseFiles = (file: string): void => {
  for (const suffix of databaseSuffixes) {
    rmSync(`${file}${suffix}`, { force: true });
  }
};

// The cache holds private repository names and titles, so only the owner may read it.
const restrictDatabaseFiles = (file: string): void => {
  for (const suffix of databaseSuffixes) {
    if (existsSync(`${file}${suffix}`)) {
      chmodSync(`${file}${suffix}`, ownerFileMode);
    }
  }
};

const createDatabaseFile = (file: string): void => {
  closeSync(openSync(file, 'a', ownerFileMode));
  restrictDatabaseFiles(file);
};

const errorCode = (error: unknown): string | null => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : null;
  }

  return null;
};

const classifyError = (error: unknown): Attempt<never> => {
  const code = errorCode(error);
  const message = describeError(error);

  if (code !== null && corruptionCodes.has(code)) {
    return { kind: 'corrupt', message };
  }

  return { kind: 'failed', message };
};

const prepareDatabase = (database: Database): Attempt<null> => {
  const row = database.query<{ user_version: number }, []>('PRAGMA user_version').get();
  const version = row?.user_version ?? 0;

  if (version === schemaVersion) {
    return { kind: 'done', value: null };
  }

  if (version !== 0) {
    return { kind: 'corrupt', message: `Unknown cache schema version ${version}` };
  }

  database.run(schema);
  database.run(`PRAGMA user_version = ${schemaVersion}`);

  return { kind: 'done', value: null };
};

const readSnapshot = (database: Database): Attempt<LocalSnapshot | null> => {
  const lastRaw = database
    .query<unknown, []>('SELECT host, login, viewerEtag, savedAt FROM last WHERE id = 1')
    .get();

  if (lastRaw === null) {
    return { kind: 'done', value: null };
  }

  const last = lastRow.safeParse(lastRaw);

  if (!last.success) {
    return { kind: 'corrupt', message: 'Invalid last row in the cache' };
  }

  const rowsRaw = database
    .query<unknown, [string, string]>(
      'SELECT path, etag, next, body FROM pages WHERE host = ? AND login = ? ORDER BY position',
    )
    .all(last.data.host, last.data.login);

  const rows = z.array(pageRow).safeParse(rowsRaw);

  if (!rows.success) {
    return { kind: 'corrupt', message: 'Invalid page row in the cache' };
  }

  return {
    kind: 'done',
    value: {
      host: last.data.host,
      login: toViewerLogin(last.data.login),
      viewerEtag: last.data.viewerEtag,
      savedAt: new Date(last.data.savedAt),
      pages: rows.data,
    },
  };
};

const writeSnapshot = (database: Database, snapshot: LocalSnapshot): void => {
  const write = database.transaction(() => {
    database.run('DELETE FROM pages WHERE host = ? AND login = ?', [snapshot.host, snapshot.login]);

    const insert = database.prepare(
      'INSERT INTO pages (host, login, position, path, etag, next, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    snapshot.pages.forEach((page, position) => {
      insert.run(
        snapshot.host,
        snapshot.login,
        position,
        page.path,
        page.etag,
        page.next,
        page.body,
      );
    });

    database.run(
      'INSERT INTO last (id, host, login, viewerEtag, savedAt) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET host = excluded.host, login = excluded.login, viewerEtag = excluded.viewerEtag, savedAt = excluded.savedAt',
      [snapshot.host, snapshot.login, snapshot.viewerEtag, snapshot.savedAt.getTime()],
    );
  });

  write();
};

const attempt = <T>(file: string, operation: (database: Database) => Attempt<T>): Attempt<T> => {
  let database: Database | null = null;

  try {
    database = new Database(file, { create: true });
    database.run(`PRAGMA busy_timeout = ${busyTimeoutMilliseconds}`);

    const prepared = prepareDatabase(database);

    if (prepared.kind !== 'done') {
      return prepared;
    }

    const result = operation(database);

    restrictDatabaseFiles(file);

    return result;
  } catch (error) {
    return classifyError(error);
  } finally {
    database?.close();
  }
};

const toResult = <T>(result: Attempt<T>): LocalStateResult<T> =>
  result.kind === 'done' ? { ok: true, value: result.value } : fail(result.message);

// A busy or locked database is never deleted. Only corruption is recreated, once.
const withDatabase = <T>(
  directory: string,
  operation: (database: Database) => Attempt<T>,
): LocalStateResult<T> => {
  try {
    mkdirSync(directory, { recursive: true, mode: ownerDirectoryMode });
    chmodSync(directory, ownerDirectoryMode);

    const file = join(directory, 'cache.db');

    createDatabaseFile(file);

    const first = attempt(file, operation);

    if (first.kind !== 'corrupt') {
      return toResult(first);
    }

    removeDatabaseFiles(file);
    createDatabaseFile(file);

    return toResult(attempt(file, operation));
  } catch (error) {
    return fail(error);
  }
};

export const loadSnapshot = (directory: string): LocalStateResult<LocalSnapshot | null> =>
  withDatabase(directory, readSnapshot);

export const saveSnapshot = (directory: string, snapshot: LocalSnapshot): LocalStateResult<null> =>
  withDatabase(directory, (database) => {
    writeSnapshot(database, snapshot);

    return { kind: 'done', value: null };
  });
