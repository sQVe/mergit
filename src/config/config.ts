import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestKeymap } from '@opentui/keymap/testing';
import { z } from 'zod';

import { catalog } from '../commands.ts';
import type { Failure, Outcome } from './notation.ts';
import { failure } from './notation.ts';
import type { ConfigFile, Remapped } from './remap.ts';
import { remapCatalog } from './remap.ts';

type FileRead =
  | { kind: 'missing' }
  | { kind: 'text'; text: string }
  | { kind: 'failed'; reason: string };

export interface ConfigEffects {
  readFile: (path: string) => FileRead;
}

export type ConfigLoad = Remapped;

const configVersion = 1;
const topLevelFields = ['version', 'keys', 'aliases'];

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const defaultEffects: ConfigEffects = {
  readFile: (path) => {
    try {
      return { kind: 'text', text: readFileSync(path, 'utf8') };
    } catch (error) {
      if (isMissingFile(error)) {
        return { kind: 'missing' };
      }

      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

const configPathOf = (environment: Record<string, string | undefined>): string | undefined => {
  const configHome = environment['XDG_CONFIG_HOME'];

  if (configHome !== undefined && configHome !== '') {
    return join(configHome, 'mergit', 'config.json');
  }

  const home = environment['HOME'];

  if (home !== undefined && home !== '') {
    return join(home, '.config', 'mergit', 'config.json');
  }

  return undefined;
};

const keyLists = z
  .unknown()
  .superRefine((value, context) => {
    if (typeof value !== 'object' || value === null) {
      return;
    }

    if (Object.hasOwn(value, '__proto__')) {
      context.addIssue({
        code: 'custom',
        path: ['__proto__'],
        message: '"__proto__" is not a config id.',
      });
    }
  })
  .pipe(z.record(z.string(), z.array(z.string())));

const configShape = z.strictObject({
  version: z.literal(configVersion),
  keys: keyLists.optional(),
  aliases: keyLists.optional(),
});

const versionProbe = z.looseObject({ version: z.unknown().optional() });

const shapeFailure = (error: z.ZodError, path: string): Failure => {
  const unknownFields = error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [],
  );

  if (unknownFields.length > 0) {
    const shown = unknownFields.map((field) => `"${field}"`).join(', ');

    return failure(
      `${path}: Unknown top-level field ${shown}. The fields are: ${topLevelFields.join(', ')}.`,
    );
  }

  const [issue] = error.issues;
  const location = issue?.path.join('.') ?? '';

  return failure(
    `${path}: "${location}" is wrong: ${issue?.message}. Each entry maps an id to a list of strings.`,
  );
};

const parseConfigText = (text: string, path: string): Outcome<ConfigFile> => {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return failure(`${path}: The file is not valid JSON (${reason}).`);
  }

  const probe = versionProbe.safeParse(json);

  if (!probe.success) {
    return failure(`${path}: The file must hold one JSON object.`);
  }

  const { version } = probe.data;

  if (version === undefined) {
    return failure(`${path}: The file has no "version" field. Add "version": ${configVersion}.`);
  }

  if (version !== configVersion) {
    const shown = JSON.stringify(version);

    return failure(`${path}: Mergit does not know version ${shown}. Use version ${configVersion}.`);
  }

  const shape = configShape.safeParse(json);

  if (shape.success) {
    return { ok: true, value: { keys: shape.data.keys ?? {}, aliases: shape.data.aliases ?? {} } };
  }

  return shapeFailure(shape.error, path);
};

export const loadConfig = (
  environment: Record<string, string | undefined>,
  effects: ConfigEffects = defaultEffects,
): ConfigLoad => {
  const path = configPathOf(environment);
  const noConfig: ConfigLoad = { ok: true, catalog, notices: [] };

  if (path === undefined) {
    return noConfig;
  }

  const read = effects.readFile(path);

  if (read.kind === 'missing') {
    return noConfig;
  }

  if (read.kind === 'failed') {
    return failure(`${path}: The file cannot be read (${read.reason}).`);
  }

  const file = parseConfigText(read.text, path);

  if (!file.ok) {
    return file;
  }

  const harness = createTestKeymap({ defaultKeys: true });
  const result = remapCatalog(file.value, path, harness.keymap);

  harness.cleanup();

  return result;
};
