import { stringifyKeySequence } from '@opentui/keymap';
// The testing module is the only export that builds a keymap without a renderer.
import type { createTestKeymap } from '@opentui/keymap/testing';

export interface Failure {
  ok: false;
  message: string;
}

export type Outcome<Value> = { ok: true; value: Value } | Failure;

export type ConfigKeymap = ReturnType<typeof createTestKeymap>['keymap'];

export const failure = (message: string): Failure => ({ ok: false, message });

const bracketStrokes = new Map([
  ['cr', 'return'],
  ['enter', 'return'],
  ['return', 'return'],
  ['esc', 'escape'],
  ['space', 'space'],
  ['tab', 'tab'],
  ['s-tab', 'shift+tab'],
  ['bs', 'backspace'],
  ['up', 'up'],
  ['down', 'down'],
  ['left', 'left'],
  ['right', 'right'],
  ['lt', '<'],
]);

const knownNames =
  '<CR>, <Enter>, <Return>, <Esc>, <Space>, <Tab>, <S-Tab>, <BS>, <Up>, <Down>, <Left>, <Right>, <lt>, <C-a> to <C-z>';

const bracketSuggestions = new Map([
  ['enter', '<CR>'],
  ['return', '<CR>'],
  ['escape', '<Esc>'],
  ['space', '<Space>'],
  ['tab', '<Tab>'],
  ['shift+tab', '<S-Tab>'],
  ['backspace', '<BS>'],
  ['up', '<Up>'],
  ['down', '<Down>'],
  ['left', '<Left>'],
  ['right', '<Right>'],
]);

const controlName = /^c-([a-z])$/;
const controlStroke = /^ctrl\+([a-z])$/;
const upperCase = /^[A-Z]$/;
const notationPattern = /<[^>]*>|./gsu;

const strokeOfBracket = (name: string): string | undefined => {
  const lower = name.toLowerCase();
  const control = controlName.exec(lower);

  if (control?.[1] !== undefined) {
    return `ctrl+${control[1]}`;
  }

  return bracketStrokes.get(lower);
};

const tokensOf = (notation: string, where: string): Outcome<string[]> => {
  if (notation === '') {
    return failure(
      `${where} is empty. Use [] to leave a command without a key. Known names: ${knownNames}.`,
    );
  }

  const tokens: string[] = [];

  for (const [piece] of notation.matchAll(notationPattern)) {
    if (piece === '<') {
      return failure(
        `${where} has a "<" with no ">". Write <lt> for the "<" key. Known names: ${knownNames}.`,
      );
    }

    if (/\s/u.test(piece)) {
      return failure(
        `${where} has whitespace. Write <Space> for the space key. Known names: ${knownNames}.`,
      );
    }

    if (piece.length > 1) {
      const stroke = strokeOfBracket(piece.slice(1, -1));

      if (stroke === undefined) {
        return failure(`${where} has the unknown name ${piece}. Known names: ${knownNames}.`);
      }

      tokens.push(stroke);
    } else {
      tokens.push(upperCase.test(piece) ? `shift+${piece.toLowerCase()}` : piece);
    }
  }

  return { ok: true, value: tokens };
};

export const strokesOf = (keymap: ConfigKeymap, key: string): string[] | undefined => {
  try {
    return keymap.parseKeySequence(key).map((part) => stringifyKeySequence([part]));
  } catch {
    return undefined;
  }
};

const suggestionFor = (strokes: readonly string[]): string => {
  const brackets = strokes.flatMap((stroke) => {
    const control = controlStroke.exec(stroke);

    if (control?.[1] !== undefined) {
      return [`<C-${control[1]}>`];
    }

    const bracket = bracketSuggestions.get(stroke);

    return bracket === undefined ? [] : [bracket];
  });

  if (brackets.length === 0) {
    return 'Write key names in brackets, such as <CR>.';
  }

  return `Write ${brackets.join(' ')} in brackets instead.`;
};

export const keyOfNotation = (
  notation: string,
  where: string,
  keymap: ConfigKeymap,
): Outcome<{ key: string; strokes: string[] }> => {
  const tokens = tokensOf(notation, where);

  if (!tokens.ok) {
    return tokens;
  }

  if (tokens.value.slice(1).includes('escape')) {
    return failure(
      `${where} uses Escape after the first stroke. Escape cancels a pending sequence. Use Escape alone or as the first stroke.`,
    );
  }

  const key = tokens.value.join('');
  const expected = tokens.value.map((token) => strokesOf(keymap, token));
  const strokes = strokesOf(keymap, key);
  const isReadable = strokes !== undefined && expected.every((stroke) => stroke?.length === 1);

  if (!isReadable) {
    return failure(`${where} is not a key the keymap can read. ${suggestionFor([])}`);
  }

  const expectedStrokes = expected.flat();

  if (strokes.join(' ') !== expectedStrokes.join(' ')) {
    return failure(
      `${where} would be read as ${strokes.join(' ')}, not as ${expectedStrokes.join(' ')}. ${suggestionFor(strokes)}`,
    );
  }

  return { ok: true, value: { key, strokes } };
};
