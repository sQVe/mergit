import type { NotificationThread, SubjectFacts } from './work/work.ts';

type Truth = boolean | 'unknown';

type AgeOperator = '<' | '>';

type StateValue = SubjectFacts['state'];

export type Query =
  | { type: 'and'; terms: Query[] }
  | { type: 'or'; terms: Query[] }
  | { type: 'not'; term: Query }
  | { type: 'text'; value: string }
  | { type: 'kind'; subjectType: string }
  | { type: 'repo'; value: string }
  | { type: 'org'; value: string }
  | { type: 'reason'; value: string }
  | { type: 'state'; value: StateValue }
  | { type: 'author'; value: string }
  | { type: 'new'; value: boolean }
  | { type: 'unread'; value: boolean }
  | { type: 'age'; operator: AgeOperator; milliseconds: number };

interface QueryError {
  message: string;
  position: number;
}

export type ParseResult = { ok: true; query: Query } | { ok: false; error: QueryError };

export interface QueryContext {
  facts: SubjectFacts | undefined;
  isNew: boolean;
  viewerLogin: string | null;
  now: Date;
}

type Token =
  | { type: 'open' | 'close' | 'or'; position: number }
  | { type: 'word'; text: string; position: number };

type Parsed<Value> = { ok: true; value: Value } | { ok: false; error: QueryError };

interface Cursor {
  tokens: Token[];
  index: number;
}

type ParseInner = (cursor: Cursor) => Parsed<Query>;

const subjectTypeByKind: Record<string, string> = {
  pr: 'PullRequest',
  issue: 'Issue',
  release: 'Release',
  discussion: 'Discussion',
  commit: 'Commit',
  ci: 'CheckSuite',
};

const stateValues = new Set(['open', 'closed', 'merged']);

const millisecondsByUnit: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const fail = (message: string, position: number): { ok: false; error: QueryError } => ({
  ok: false,
  error: { message, position },
});

const succeed = <Value>(value: Value): Parsed<Value> => ({ ok: true, value });

const isStateValue = (value: string): value is StateValue => stateValues.has(value);

const isSeparator = (character: string): boolean =>
  character === '(' || character === ')' || /\s/.test(character);

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);

    if (character === '(') {
      tokens.push({ type: 'open', position: index });
      index += 1;
    } else if (character === ')') {
      tokens.push({ type: 'close', position: index });
      index += 1;
    } else if (/\s/.test(character)) {
      index += 1;
    } else {
      const start = index;

      while (index < text.length && !isSeparator(text.charAt(index))) {
        index += 1;
      }

      const word = text.slice(start, index);

      tokens.push(
        word === 'OR'
          ? { type: 'or', position: start }
          : { type: 'word', text: word, position: start },
      );
    }
  }

  return tokens;
};

const parseBoolean = (value: string, position: number): Parsed<boolean> => {
  if (value === 'true') {
    return succeed(true);
  }

  if (value === 'false') {
    return succeed(false);
  }

  return fail(`Expected true or false, got "${value}".`, position);
};

const parseKind = (value: string, position: number): Parsed<Query> => {
  const subjectType = subjectTypeByKind[value];

  if (subjectType === undefined) {
    return fail(
      `Unknown kind "${value}". Use pr, issue, release, discussion, commit, or ci.`,
      position,
    );
  }

  return succeed({ type: 'kind', subjectType });
};

const parseState = (value: string, position: number): Parsed<Query> => {
  if (!isStateValue(value)) {
    return fail(`Unknown state "${value}". Use open, closed, or merged.`, position);
  }

  return succeed({ type: 'state', value });
};

const parseAge = (value: string, position: number): Parsed<Query> => {
  const match = /^([<>])(\d+)([mhdw])$/.exec(value);
  const operator = match?.[1];
  const amount = match?.[2];
  const unit = match?.[3];

  if (operator === undefined || amount === undefined || unit === undefined) {
    return fail(
      `Invalid age "${value}". Use < or >, a number, and a unit m, h, d, or w, such as >7d.`,
      position,
    );
  }

  const milliseconds = Number(amount) * (millisecondsByUnit[unit] ?? 0);

  return succeed({ type: 'age', operator: operator === '<' ? '<' : '>', milliseconds });
};

const parseIs = (value: string, position: number): Parsed<Query> => {
  if (value in subjectTypeByKind) {
    return parseKind(value, position);
  }

  if (isStateValue(value)) {
    return parseState(value, position);
  }

  if (value === 'new' || value === 'unread') {
    return succeed({ type: value, value: true });
  }

  if (value === 'read') {
    return succeed({ type: 'unread', value: false });
  }

  return fail(`Unknown is: value "${value}".`, position);
};

const parseBooleanField = (
  field: 'new' | 'unread',
  value: string,
  position: number,
): Parsed<Query> => {
  const parsed = parseBoolean(value, position);

  if (!parsed.ok) {
    return parsed;
  }

  return succeed({ type: field, value: parsed.value });
};

const parseValue = (field: string, value: string, position: number): Parsed<Query> => {
  switch (field) {
    case 'kind':
      return parseKind(value, position);
    case 'repo':
      return succeed({ type: 'repo', value });
    case 'org':
      return succeed({ type: 'org', value });
    case 'reason':
      return succeed({ type: 'reason', value });
    case 'state':
      return parseState(value, position);
    case 'author':
      return succeed({ type: 'author', value });
    case 'new':
    case 'unread':
      return parseBooleanField(field, value, position);
    case 'age':
      return parseAge(value, position);
    default:
      return parseIs(value, position);
  }
};

const fieldNames = new Set([
  'kind',
  'repo',
  'org',
  'reason',
  'state',
  'author',
  'new',
  'unread',
  'age',
  'is',
]);

const parseQualifier = (
  field: string,
  rawValue: string,
  fieldPosition: number,
  valuePosition: number,
): Parsed<Query> => {
  const fieldName = field.toLowerCase();

  if (!fieldNames.has(fieldName)) {
    return fail(`Unknown field "${field}".`, fieldPosition);
  }

  const terms: Query[] = [];
  let offset = 0;

  for (const part of rawValue.split(',')) {
    const position = valuePosition + offset;

    if (part === '') {
      return fail(`Missing value for ${fieldName}:.`, position);
    }

    const parsed = parseValue(fieldName, part.toLowerCase(), position);

    if (!parsed.ok) {
      return parsed;
    }

    terms.push(parsed.value);
    offset += part.length + 1;
  }

  const [only] = terms;

  return succeed(terms.length === 1 && only !== undefined ? only : { type: 'or', terms });
};

const parseWord = (text: string, position: number): Parsed<Query> => {
  const negated = text.startsWith('-') && text.length > 1;
  const body = negated ? text.slice(1) : text;
  const bodyPosition = negated ? position + 1 : position;
  const colon = body.indexOf(':');

  const parsed: Parsed<Query> =
    colon > 0
      ? parseQualifier(
          body.slice(0, colon),
          body.slice(colon + 1),
          bodyPosition,
          bodyPosition + colon + 1,
        )
      : succeed({ type: 'text', value: body.toLowerCase() });

  if (!parsed.ok || !negated) {
    return parsed;
  }

  return succeed({ type: 'not', term: parsed.value });
};

const parseGroup = (
  cursor: Cursor,
  openPosition: number,
  parseInner: ParseInner,
): Parsed<Query> => {
  const first = cursor.tokens[cursor.index];

  if (first?.type === 'close') {
    return fail('Parentheses must contain a term.', openPosition);
  }

  const inner = parseInner(cursor);

  if (!inner.ok) {
    return inner;
  }

  const close = cursor.tokens[cursor.index];

  if (close?.type !== 'close') {
    return fail('Missing closing parenthesis.', openPosition);
  }

  cursor.index += 1;

  return inner;
};

const parseNegatedGroup = (cursor: Cursor, minus: Token, parseInner: ParseInner): Parsed<Query> => {
  const next = cursor.tokens[cursor.index];

  if (next?.type !== 'open') {
    return fail('Expected a term after "-".', minus.position);
  }

  cursor.index += 1;

  const group = parseGroup(cursor, next.position, parseInner);

  return group.ok ? succeed({ type: 'not', term: group.value }) : group;
};

const parseTerm = (cursor: Cursor, token: Token, parseInner: ParseInner): Parsed<Query> => {
  cursor.index += 1;

  if (token.type === 'open') {
    return parseGroup(cursor, token.position, parseInner);
  }

  if (token.type === 'word' && token.text === '-') {
    return parseNegatedGroup(cursor, token, parseInner);
  }

  if (token.type === 'word') {
    return parseWord(token.text, token.position);
  }

  return fail('Unexpected token.', token.position);
};

const parseSequence = (cursor: Cursor, parseInner: ParseInner): Parsed<Query> => {
  const terms: Query[] = [];

  for (;;) {
    const token = cursor.tokens[cursor.index];

    if (token === undefined || token.type === 'close' || token.type === 'or') {
      break;
    }

    const term = parseTerm(cursor, token, parseInner);

    if (!term.ok) {
      return term;
    }

    terms.push(term.value);
  }

  const [first] = terms;

  if (first === undefined) {
    const next = cursor.tokens[cursor.index];

    return fail('Expected a term before OR.', next?.position ?? 0);
  }

  return succeed(terms.length === 1 ? first : { type: 'and', terms });
};

const parseExpression: ParseInner = (cursor) => {
  const terms: Query[] = [];

  for (;;) {
    const sequence = parseSequence(cursor, parseExpression);

    if (!sequence.ok) {
      return sequence;
    }

    terms.push(sequence.value);

    const next = cursor.tokens[cursor.index];

    if (next?.type !== 'or') {
      break;
    }

    cursor.index += 1;

    const after = cursor.tokens[cursor.index];

    if (after === undefined || after.type === 'close' || after.type === 'or') {
      return fail('Expected a term after OR.', next.position);
    }
  }

  const [only] = terms;

  return succeed(terms.length === 1 && only !== undefined ? only : { type: 'or', terms });
};

export const parse = (text: string): ParseResult => {
  const cursor: Cursor = { tokens: tokenize(text), index: 0 };

  if (cursor.tokens.length === 0) {
    return { ok: true, query: { type: 'and', terms: [] } };
  }

  const parsed = parseExpression(cursor);

  if (!parsed.ok) {
    return parsed;
  }

  const rest = cursor.tokens[cursor.index];

  if (rest !== undefined) {
    return fail('Unmatched closing parenthesis.', rest.position);
  }

  return { ok: true, query: parsed.value };
};

const negate = (value: Truth): Truth => (value === 'unknown' ? 'unknown' : !value);

const all = (values: Truth[]): Truth => {
  if (values.includes(false)) {
    return false;
  }

  return values.includes('unknown') ? 'unknown' : true;
};

const any = (values: Truth[]): Truth => {
  if (values.includes(true)) {
    return true;
  }

  return values.includes('unknown') ? 'unknown' : false;
};

const sameText = (left: string, right: string): boolean => left.toLowerCase() === right;

const evaluateAuthor = (value: string, context: QueryContext): Truth => {
  const author = context.facts?.author ?? null;
  const expected = value === '@me' ? context.viewerLogin : value;

  if (author === null || expected === null) {
    return 'unknown';
  }

  return sameText(author, expected.toLowerCase());
};

const evaluateAge = (
  query: { operator: AgeOperator; milliseconds: number },
  thread: NotificationThread,
  context: QueryContext,
): Truth => {
  const updated = Date.parse(thread.updatedAt);

  if (Number.isNaN(updated)) {
    return 'unknown';
  }

  const age = context.now.getTime() - updated;

  return query.operator === '>' ? age > query.milliseconds : age < query.milliseconds;
};

const evaluateText = (value: string, thread: NotificationThread): boolean => {
  const title = thread.title.toLowerCase();
  const repository = thread.repository.toLowerCase();

  return title.includes(value) || repository.includes(value);
};

const evaluateThreadField = (query: Query, thread: NotificationThread): Truth => {
  if (query.type === 'text') {
    return evaluateText(query.value, thread);
  }

  if (query.type === 'kind') {
    return thread.subjectType === query.subjectType;
  }

  if (query.type === 'repo') {
    return sameText(thread.repository, query.value);
  }

  if (query.type === 'org') {
    return sameText(thread.repository.split('/')[0] ?? '', query.value);
  }

  if (query.type === 'reason') {
    return sameText(thread.reason, query.value);
  }

  return query.type === 'unread' ? thread.unread === query.value : 'unknown';
};

const evaluateContextField = (
  query: Query,
  thread: NotificationThread,
  context: QueryContext,
): Truth => {
  if (query.type === 'state') {
    return context.facts === undefined ? 'unknown' : context.facts.state === query.value;
  }

  if (query.type === 'author') {
    return evaluateAuthor(query.value, context);
  }

  if (query.type === 'new') {
    return context.isNew === query.value;
  }

  return query.type === 'age' ? evaluateAge(query, thread, context) : 'unknown';
};

const evaluateField = (query: Query, thread: NotificationThread, context: QueryContext): Truth => {
  const fromThread = evaluateThreadField(query, thread);

  return fromThread === 'unknown' ? evaluateContextField(query, thread, context) : fromThread;
};

export const evaluate = (
  query: Query,
  thread: NotificationThread,
  context: QueryContext,
): Truth => {
  if (query.type === 'and') {
    return all(query.terms.map((term) => evaluate(term, thread, context)));
  }

  if (query.type === 'or') {
    return any(query.terms.map((term) => evaluate(term, thread, context)));
  }

  if (query.type === 'not') {
    return negate(evaluate(query.term, thread, context));
  }

  return evaluateField(query, thread, context);
};
