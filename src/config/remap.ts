import type { Command, OverlayScope } from '../commands.ts';
import { catalog, commandsOfLayer, isOverlayScope, readableKeyOf } from '../commands.ts';
import { invariant } from '../invariant.ts';
import type { ConfigKeymap, Failure, Outcome } from './notation.ts';
import { failure, keyOfNotation, strokesOf } from './notation.ts';

export interface ConfigFile {
  keys: Record<string, string[]>;
  aliases: Record<string, string[]>;
}

interface ParsedKey {
  key: string;
  strokes: string[];
  notation: string | undefined;
}

interface LayerKey extends ParsedKey {
  command: Command;
  removed: boolean;
}

interface Replacement {
  winner: string;
  loser: string;
  winnerKey: string;
  loserKey: string;
  layers: string[];
}

interface Remap {
  path: string;
  replacements: Map<string, Replacement>;
}

export type Remapped = { ok: true; catalog: readonly Command[]; notices: string[] } | Failure;

const configIdOf = (command: Command): string => command.configId ?? command.id;

const isConfigurable = (command: Command): boolean => command.configurable !== false;

const isListOrGlobal = (command: Command): boolean =>
  command.scope === 'global' || command.scope === 'list';

const configIdsOf = (commands: readonly Command[], include: (command: Command) => boolean) => [
  ...new Set(commands.filter(include).map((command) => configIdOf(command))),
];

const userKeysOf = (
  id: string,
  notations: readonly string[],
  context: { path: string; keymap: ConfigKeymap; commands: readonly Command[] },
): Outcome<ParsedKey[]> => {
  const { path, keymap, commands } = context;
  const countsKeys = commands.some((command) => isListOrGlobal(command));
  const userKeys: ParsedKey[] = [];

  for (const notation of notations) {
    const where = `${path}: keys.${id} "${notation}"`;
    const parsed = keyOfNotation(notation, where, keymap);

    if (!parsed.ok) {
      return parsed;
    }

    const { key, strokes } = parsed.value;

    if (strokes.includes('ctrl+c')) {
      if (id === 'quit' && strokes.length === 1) {
        continue;
      }

      return failure(
        `${where} uses Ctrl+C. Ctrl+C always stays on quit, and no other key may use <C-c>.`,
      );
    }

    if (countsKeys && /^[1-9]$/.test(strokes[0] ?? '')) {
      return failure(`${where} starts with a digit. Digits 1-9 start a count in the list.`);
    }

    // Duplicate encodings keep both entries, but diagnostics use their last notation.
    for (const previous of userKeys) {
      if (previous.key === key) {
        previous.notation = notation;
      }
    }

    userKeys.push({ key, strokes, notation });
  }

  return { ok: true, value: userKeys };
};

const relationOf = (first: readonly string[], second: readonly string[]): boolean => {
  const shared = Math.min(first.length, second.length);

  return first.slice(0, shared).join(' ') === second.slice(0, shared).join(' ');
};

const recordReplacement = (
  state: Remap,
  winner: LayerKey,
  loser: LayerKey,
  scope: Command['scope'],
): void => {
  const replacement: Replacement = {
    winner: configIdOf(winner.command),
    loser: configIdOf(loser.command),
    winnerKey: winner.notation ?? winner.key,
    loserKey: readableKeyOf(loser.key),
    layers: [],
  };

  const identity = JSON.stringify({ ...replacement, layers: undefined });
  const known = state.replacements.get(identity) ?? replacement;

  known.layers.push(scope);
  state.replacements.set(identity, known);
};

const parsedKeysOf = (
  command: Command,
  userKeys: ReadonlyMap<string, ParsedKey[]>,
  keymap: ConfigKeymap,
): ParsedKey[] => {
  const configured = userKeys.get(configIdOf(command));

  if (configured === undefined) {
    return command.keys.map((key) => ({
      key,
      strokes: strokesOf(keymap, key) ?? [],
      notation: undefined,
    }));
  }

  if (command.id === 'quit') {
    return [...configured, { key: 'ctrl+c', strokes: ['ctrl+c'], notation: undefined }];
  }

  return configured;
};

const layerKeysOf = (
  scope: Command['scope'],
  userKeys: ReadonlyMap<string, ParsedKey[]>,
  keymap: ConfigKeymap,
): LayerKey[] =>
  commandsOfLayer(catalog, scope).flatMap((command) =>
    parsedKeysOf(command, userKeys, keymap).map((entry) =>
      Object.assign({}, entry, { command, removed: false }),
    ),
  );

const conflictBetween = (
  state: Remap,
  first: LayerKey,
  second: LayerKey,
  scope: Command['scope'],
): Failure | undefined => {
  const firstId = configIdOf(first.command);
  const secondId = configIdOf(second.command);
  const shownFirst = `keys.${firstId} "${first.notation}"`;
  const shownSecond = `keys.${secondId} "${second.notation}"`;
  const where = `${state.path}: ${shownFirst} and ${shownSecond}`;

  if (first.strokes.length === second.strokes.length) {
    return failure(
      `${where} use the same key in the ${scope} layer. Give one of them another key.`,
    );
  }

  const [blocker, blocked] =
    first.strokes.length < second.strokes.length
      ? [shownFirst, shownSecond]
      : [shownSecond, shownFirst];

  return failure(
    `${where} clash in the ${scope} layer: ${blocker} starts ${blocked}, so ${blocked} can never run.`,
  );
};

const resolveLayer = (
  state: Remap,
  scope: Command['scope'],
  entries: LayerKey[],
): Failure | undefined => {
  for (const [index, first] of entries.entries()) {
    for (const second of entries.slice(index + 1)) {
      const touches = relationOf(first.strokes, second.strokes);
      const isUserPair = first.notation !== undefined && second.notation !== undefined;

      if (!touches) {
        continue;
      }

      if (isUserPair) {
        return conflictBetween(state, first, second, scope);
      }

      if (first.notation !== undefined) {
        second.removed = true;
        recordReplacement(state, first, second, scope);
      } else if (second.notation !== undefined) {
        first.removed = true;
        recordReplacement(state, second, first, scope);
      }
    }
  }

  return undefined;
};

const noticeOf = (replacement: Replacement): string => {
  const { winner, loser, winnerKey, loserKey, layers } = replacement;

  return `Key "${winnerKey}" of ${winner} replaces the default "${loserKey}" of ${loser} in the ${layers.join(', ')} layers.`;
};

const keysOfEntries = (
  file: ConfigFile,
  path: string,
  keymap: ConfigKeymap,
): Outcome<Map<string, ParsedKey[]>> => {
  const validIds = configIdsOf(catalog, isConfigurable);
  const userKeys = new Map<string, ParsedKey[]>();

  for (const [id, notations] of Object.entries(file.keys)) {
    if (!validIds.includes(id)) {
      return failure(`${path}: keys.${id} is not a config id. Valid ids: ${validIds.join(', ')}`);
    }

    const commands = catalog.filter((command) => configIdOf(command) === id);
    const parsed = userKeysOf(id, notations, { path, keymap, commands });

    if (!parsed.ok) {
      return parsed;
    }

    userKeys.set(id, parsed.value);
  }

  return { ok: true, value: userKeys };
};

const survivingEntriesOf = (
  layers: ReadonlyMap<Command['scope'], LayerKey[]>,
  scope: Command['scope'],
  id: string,
): LayerKey[] => {
  const entries = layers.get(scope);

  invariant(entries !== undefined, `The ${scope} layer was compiled before resolution.`);

  return entries.filter((entry) => entry.command.id === id && !entry.removed);
};

const catalogOfLayers = (layers: ReadonlyMap<Command['scope'], LayerKey[]>): Command[] => {
  const overlayScopes: OverlayScope[] = [...layers.keys()].filter(isOverlayScope);

  return catalog.map((command) => {
    const keys = survivingEntriesOf(layers, command.scope, command.id).map((entry) => entry.key);
    const projected: Command = { ...command, keys };

    if (command.overlayMove !== undefined) {
      for (const scope of overlayScopes) {
        const overlayKeys = survivingEntriesOf(layers, scope, command.id).map((entry) => entry.key);

        const sameKeys =
          keys.length === overlayKeys.length &&
          keys.every((key, index) => key === overlayKeys[index]);

        if (!sameKeys) {
          projected.overlayKeys = { ...projected.overlayKeys, [scope]: overlayKeys };
        }
      }
    }

    return projected;
  });
};

const keylessCommands = (working: readonly Command[]): Command[] =>
  working.filter((command) => command.mustKeepKey === true && command.keys.length === 0);

const nameClash = (
  owners: ReadonlyMap<string, string>,
  alias: { id: string; name: string; path: string },
): Failure | undefined => {
  const { id, name, path } = alias;
  const where = `${path}: aliases.${id} "${name}"`;
  const owner = owners.get(name);

  if (name === '' || /\s/u.test(name)) {
    return failure(`${where} must not be empty or contain whitespace.`);
  }

  if (owner !== undefined && owner !== id) {
    return failure(`${where} is already used by ${owner}.`);
  }

  return undefined;
};

const applyAliases = (working: Command[], file: ConfigFile, path: string): Failure | undefined => {
  const aliasIds = configIdsOf(
    catalog,
    (command) => isConfigurable(command) && isListOrGlobal(command),
  );

  const owners = new Map<string, string>();

  for (const command of working) {
    for (const name of command.names ?? []) {
      owners.set(name, configIdOf(command));
    }
  }

  for (const [id, names] of Object.entries(file.aliases)) {
    if (!aliasIds.includes(id)) {
      return failure(
        `${path}: aliases.${id} cannot take aliases. Ids that take aliases: ${aliasIds.join(', ')}`,
      );
    }

    for (const name of names) {
      const nameFailure = nameClash(owners, { id, name, path });

      if (nameFailure !== undefined) {
        return nameFailure;
      }

      owners.set(name, id);
    }

    for (const command of working.filter((candidate) => configIdOf(candidate) === id)) {
      command.names = [...new Set([...(command.names ?? []), ...names])];
    }
  }

  return undefined;
};

const keylessFailure = (working: readonly Command[], path: string): Failure | undefined => {
  const [keyless] = keylessCommands(working);

  if (keyless === undefined) {
    return undefined;
  }

  const required = configIdsOf(catalog, (command) => command.mustKeepKey === true);

  return failure(
    `${path}: ${configIdOf(keyless)} has no key. These commands must keep a key: ${required.join(', ')}`,
  );
};

const protocolDependentStrokes = new Set(['ctrl+i', 'ctrl+m', 'ctrl+h', 'ctrl+j']);

const isPortable = (entry: LayerKey): boolean =>
  entry.strokes.every((stroke) => !protocolDependentStrokes.has(stroke));

const portableKeyFailure = (
  layers: ReadonlyMap<Command['scope'], LayerKey[]>,
  path: string,
): Failure | undefined => {
  const required = catalog.filter((command) => command.mustKeepKey === true);

  for (const command of required) {
    const entries = survivingEntriesOf(layers, command.scope, command.id);

    if (entries.some(isPortable)) {
      continue;
    }

    return failure(
      `${path}: ${configIdOf(command)} has no portable key. Ctrl+I, Ctrl+M, Ctrl+H, and Ctrl+J require Kitty keyboard reporting. Keep or add another portable key without these controls in any stroke.`,
    );
  }

  return undefined;
};

export const remapCatalog = (file: ConfigFile, path: string, keymap: ConfigKeymap): Remapped => {
  const userKeys = keysOfEntries(file, path, keymap);

  if (!userKeys.ok) {
    return userKeys;
  }

  const scopes = [...new Set(catalog.map((command) => command.scope))];

  const layers = new Map(
    scopes.map((scope) => [scope, layerKeysOf(scope, userKeys.value, keymap)]),
  );

  const state: Remap = { path, replacements: new Map() };

  for (const [scope, entries] of layers) {
    const conflict = resolveLayer(state, scope, entries);

    if (conflict !== undefined) {
      return conflict;
    }
  }

  const working = catalogOfLayers(layers);
  const keyless = keylessFailure(working, path);

  if (keyless !== undefined) {
    return keyless;
  }

  const portableFailure = portableKeyFailure(layers, path);

  if (portableFailure !== undefined) {
    return portableFailure;
  }

  const aliasFailure = applyAliases(working, file, path);

  if (aliasFailure !== undefined) {
    return aliasFailure;
  }

  return { ok: true, catalog: working, notices: [...state.replacements.values()].map(noticeOf) };
};
