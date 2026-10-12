import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
  savedAt: Date;
  pages: LocalPage[];
}

interface LocalStateFailure {
  message: string;
}

export type LocalStateResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: LocalStateFailure };

interface PageRow {
  path: string;
  etag: string | null;
  next: string | null;
  body: string;
}

interface LastRow {
  host: string;
  login: string;
  savedAt: number;
}

const schemaVersion = 1;

const schema = `
  CREATE TABLE IF NOT EXISTS last (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT NOT NULL,
    login TEXT NOT NULL,
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
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${file}${suffix}`, { force: true });
  }
};

const prepareDatabase = (file: string): Database => {
  const database = new Database(file, { create: true });

  try {
    const row = database.query<{ user_version: number }, []>('PRAGMA user_version').get();
    const version = row?.user_version ?? 0;

    if (version !== 0 && version !== schemaVersion) {
      throw new Error(`Unknown cache schema version ${version}`);
    }

    database.run(schema);
    database.run(`PRAGMA user_version = ${schemaVersion}`);

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const openDatabase = (directory: string): Database => {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'cache.db');

  try {
    return prepareDatabase(file);
  } catch {
    removeDatabaseFiles(file);

    return prepareDatabase(file);
  }
};

const readSnapshot = (database: Database): LocalSnapshot | null => {
  const last = database
    .query<LastRow, []>('SELECT host, login, savedAt FROM last WHERE id = 1')
    .get();

  if (last === null) {
    return null;
  }

  const rows = database
    .query<PageRow, [string, string]>(
      'SELECT path, etag, next, body FROM pages WHERE host = ? AND login = ? ORDER BY position',
    )
    .all(last.host, last.login);

  return {
    host: last.host,
    login: toViewerLogin(last.login),
    savedAt: new Date(last.savedAt),
    pages: rows.map((row) => ({
      path: row.path,
      etag: row.etag,
      next: row.next,
      body: row.body,
    })),
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
      'INSERT INTO last (id, host, login, savedAt) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET host = excluded.host, login = excluded.login, savedAt = excluded.savedAt',
      [snapshot.host, snapshot.login, snapshot.savedAt.getTime()],
    );
  });

  write();
};

export const loadSnapshot = (directory: string): LocalStateResult<LocalSnapshot | null> => {
  try {
    const database = openDatabase(directory);

    try {
      return { ok: true, value: readSnapshot(database) };
    } finally {
      database.close();
    }
  } catch (error) {
    return fail(error);
  }
};

export const saveSnapshot = (
  directory: string,
  snapshot: LocalSnapshot,
): LocalStateResult<null> => {
  try {
    const database = openDatabase(directory);

    try {
      writeSnapshot(database, snapshot);

      return { ok: true, value: null };
    } finally {
      database.close();
    }
  } catch (error) {
    return fail(error);
  }
};
