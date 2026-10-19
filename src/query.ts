import { invariant } from './invariant.ts';
import type { NotificationThread, SubjectFacts } from './work/work.ts';

type Truth = boolean | 'unknown';

type AgeOperator = '<' | '>';

type StateValue = SubjectFacts['state'];

export type Query =
  | { type: 'and'; terms: Query[] }
  | { type: 'or'; terms: Query[] }
  | { type: 'not'; term: Query }
  | { type: 'text'; value: string }
  | { type: 'title'; value: string }
  | { type: 'kind'; subjectType: string }
  | { type: 'repo'; value: string }
  | { type: 'org'; value: string }
  | { type: 'reason'; value: string }
  | { type: 'state'; value: StateValue }
  | { type: 'author'; value: string }
  | { type: 'new'; value: boolean }
  | { type: 'unread'; value: boolean }
  | { type: 'age'; operator: AgeOperator; milliseconds: number };

export type FilterField =
  | 'kind'
  | 'repo'
  | 'org'
  | 'author'
  | 'reason'
  | 'state'
  | 'new'
  | 'unread'
  | 'age'
  | 'title';

export interface Filter {
  field: FilterField;
  value: string;
  negated: boolean;
}

export type ParseFiltersResult = { ok: true; filters: Filter[] } | { ok: false; error: string };

export interface FilterCandidate {
  field: FilterField;
  value: string;
  count: number;
}

export interface FilterCandidateContext {
  factsOf: (thread: NotificationThread) => SubjectFacts | undefined;
  isNew: (thread: NotificationThread) => boolean;
  viewerLogin: string | null;
}

type Parsed<Value> = { ok: true; value: Value } | { ok: false; error: string };

export interface QueryContext {
  facts: SubjectFacts | undefined;
  isNew: boolean;
  viewerLogin: string | null;
  now: Date | null;
}

export const searchQuery = (text: string): Query | null => {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');

  if (words.length === 0) {
    return null;
  }

  return { type: 'and', terms: words.map((value) => ({ type: 'text', value })) };
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

// The pattern is lower case and holds at most one `*`.
const matchesPattern = (actual: string, pattern: string): boolean => {
  const lower = actual.toLowerCase();
  const star = pattern.indexOf('*');

  if (star === -1) {
    return lower === pattern;
  }

  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  const longEnough = lower.length >= prefix.length + suffix.length;

  return longEnough && lower.startsWith(prefix) && lower.endsWith(suffix);
};

const evaluateAuthor = (value: string, context: QueryContext): Truth => {
  const author = context.facts?.author ?? null;
  const expected = value === '@me' ? context.viewerLogin : value;

  if (author === null || expected === null) {
    return 'unknown';
  }

  return matchesPattern(author, expected.toLowerCase());
};

const evaluateAge = (
  query: { operator: AgeOperator; milliseconds: number },
  thread: NotificationThread,
  context: QueryContext,
): Truth => {
  const updated = Date.parse(thread.updatedAt);

  if (Number.isNaN(updated) || context.now === null) {
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

  if (query.type === 'title') {
    return thread.title.toLowerCase().includes(query.value);
  }

  if (query.type === 'kind') {
    return thread.subjectType === query.subjectType;
  }

  if (query.type === 'repo') {
    return matchesPattern(thread.repository, query.value);
  }

  if (query.type === 'org') {
    return matchesPattern(thread.repository.split('/')[0] ?? '', query.value);
  }

  if (query.type === 'reason') {
    return thread.reason.toLowerCase() === query.value.toLowerCase();
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

export const filterFields: FilterField[] = [
  'kind',
  'repo',
  'org',
  'author',
  'reason',
  'state',
  'new',
  'unread',
  'age',
  'title',
];

const subjectTypeByKind: Record<string, string> = {
  pr: 'PullRequest',
  issue: 'Issue',
  release: 'Release',
  discussion: 'Discussion',
  commit: 'Commit',
  ci: 'CheckSuite',
};

const millisecondsByUnit: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const stateValues = new Set<string>(['open', 'closed', 'merged']);

const isFilterField = (name: string): name is FilterField => filterFields.some((f) => f === name);

const subjectTypeOf = (kind: string): string | undefined =>
  Object.hasOwn(subjectTypeByKind, kind) ? subjectTypeByKind[kind] : undefined;

const isStateValue = (value: string): value is StateValue => stateValues.has(value);

const isBooleanText = (value: string): boolean => value === 'true' || value === 'false';

const maxAgeDigits = 9;

const parseAge = (value: string): { operator: AgeOperator; milliseconds: number } | null => {
  const match = /^([<>])(\d+)([mhdw])$/.exec(value);
  const operator = match?.[1];
  const amount = match?.[2];
  const unit = match?.[3];

  if (operator === undefined || amount === undefined || unit === undefined) {
    return null;
  }

  if (Number(amount) < 1) {
    return null;
  }

  if (amount.length > maxAgeDigits) {
    return null;
  }

  return {
    operator: operator === '<' ? '<' : '>',
    milliseconds: Number(amount) * (millisecondsByUnit[unit] ?? 0),
  };
};

const splitTokens = (text: string): Parsed<string[]> => {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;

  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
    } else if (!quoted && /\s/.test(character)) {
      if (current !== '') {
        tokens.push(current);
      }

      current = '';
    } else {
      current += character;
    }
  }

  if (quoted) {
    return { ok: false, error: `Invalid filter "${current}": the quote is not closed.` };
  }

  if (current !== '') {
    tokens.push(current);
  }

  return { ok: true, value: tokens };
};

const unquote = (value: string): string => value.replaceAll('"', '');

const normalizeIs = (value: string): { field: FilterField; value: string } | null => {
  if (subjectTypeOf(value) !== undefined) {
    return { field: 'kind', value };
  }

  if (isStateValue(value)) {
    return { field: 'state', value };
  }

  if (value === 'new') {
    return { field: 'new', value: 'true' };
  }

  if (value === 'unread') {
    return { field: 'unread', value: 'true' };
  }

  return value === 'read' ? { field: 'unread', value: 'false' } : null;
};

const checkOpenValue = (field: FilterField, value: string): string | null => {
  if (field === 'age' && parseAge(value) === null) {
    return 'age takes < or >, a whole number of 1 or more, and a unit m, h, d, or w, such as >7d';
  }

  const wildcardField = field === 'repo' || field === 'org' || field === 'author';

  if (wildcardField && value.split('*').length > 2) {
    return `${field} takes at most one *`;
  }

  return null;
};

const checkValue = (field: FilterField, value: string): string | null => {
  if (value === '') {
    return `${field} needs a value`;
  }

  if (field === 'kind' && subjectTypeOf(value) === undefined) {
    return 'kind takes pr, issue, release, discussion, commit, or ci';
  }

  if (field === 'state' && !isStateValue(value)) {
    return 'state takes open, closed, or merged';
  }

  const booleanField = field === 'new' || field === 'unread';

  if (booleanField && !isBooleanText(value)) {
    return `${field} takes true or false`;
  }

  return checkOpenValue(field, value);
};

const lowercasedFields = new Set<FilterField>(['kind', 'state', 'new', 'unread']);

const normalizeValue = (field: FilterField, value: string): string => {
  if (field === 'reason') {
    return value.toLowerCase().replaceAll('-', '_');
  }

  if (field === 'author' && value.toLowerCase().startsWith('app/')) {
    return `${value.slice('app/'.length)}[bot]`;
  }

  return lowercasedFields.has(field) ? value.toLowerCase() : value;
};

const parseToken = (token: string): Parsed<Filter> => {
  const negated = token.startsWith('-');
  const body = negated ? token.slice(1) : token;
  const colon = body.indexOf(':');

  if (colon === -1) {
    return { ok: false, error: `Invalid filter "${token}": expected field:value.` };
  }

  const name = body.slice(0, colon).toLowerCase();
  const rawValue = unquote(body.slice(colon + 1));
  const alias = name === 'is' ? normalizeIs(rawValue.toLowerCase()) : null;
  const field = alias?.field ?? name;

  if (!isFilterField(field)) {
    const valid = name === 'is' ? 'kind, state, new, or unread' : filterFields.join(', ');
    const subject = name === 'is' ? `value "${rawValue}"` : `field "${name}"`;

    return { ok: false, error: `Invalid filter "${token}": unknown ${subject}. Use ${valid}.` };
  }

  const value = normalizeValue(field, alias?.value ?? rawValue);
  const problem = checkValue(field, value);

  if (problem !== null) {
    return { ok: false, error: `Invalid filter "${token}": ${problem}.` };
  }

  return { ok: true, value: { field, value, negated } };
};

export const parseFilters = (text: string): ParseFiltersResult => {
  const filters: Filter[] = [];

  const split = splitTokens(text);

  if (!split.ok) {
    return split;
  }

  for (const token of split.value) {
    const parsed = parseToken(token);

    if (!parsed.ok) {
      return parsed;
    }

    filters.push(parsed.value);
  }

  return { ok: true, filters };
};

export const formatFilter = (filter: Filter): string => {
  const value = /\s/.test(filter.value) ? `"${filter.value}"` : filter.value;

  return `${filter.negated ? '-' : ''}${filter.field}:${value}`;
};

const filterTerm = (filter: Filter): Query => {
  const value = filter.value.toLowerCase();
  const { field } = filter;

  if (field === 'kind') {
    const subjectType = subjectTypeOf(value);

    invariant(subjectType !== undefined, `Invalid kind filter value "${filter.value}".`);

    return { type: 'kind', subjectType };
  }

  if (field === 'state') {
    invariant(isStateValue(value), `Invalid state filter value "${filter.value}".`);

    return { type: 'state', value };
  }

  if (field === 'new' || field === 'unread') {
    invariant(isBooleanText(value), `Invalid ${field} filter value "${filter.value}".`);

    return { type: field, value: value === 'true' };
  }

  if (field === 'age') {
    const age = parseAge(value);

    invariant(age !== null, `Invalid age filter value "${filter.value}".`);

    return { type: 'age', ...age };
  }

  return { type: field, value };
};

const groupTerms = (terms: Query[]): Query | null => {
  const [first] = terms;

  if (first === undefined) {
    return null;
  }

  return terms.length === 1 ? first : { type: 'or', terms };
};

export const filterQuery = (filters: Filter[]): Query | null => {
  const positiveByField = new Map<FilterField, Query[]>();
  const terms: Query[] = [];
  const conjunctive = new Set<FilterField>(['age', 'title']);

  for (const filter of filters) {
    if (filter.negated) {
      terms.push({ type: 'not', term: filterTerm(filter) });
    } else if (conjunctive.has(filter.field)) {
      terms.push(filterTerm(filter));
    } else {
      const group = positiveByField.get(filter.field) ?? [];

      group.push(filterTerm(filter));
      positiveByField.set(filter.field, group);
    }
  }

  const positives = [...positiveByField.values()].flatMap((group) => groupTerms(group) ?? []);
  const combined = [...positives, ...terms];
  const [first] = combined;

  if (first === undefined) {
    return null;
  }

  return combined.length === 1 ? first : { type: 'and', terms: combined };
};

const kindByType = new Map(Object.entries(subjectTypeByKind).map(([kind, type]) => [type, kind]));

const factValues = (
  thread: NotificationThread,
  context: FilterCandidateContext,
): Record<string, string | null> => {
  const facts = context.factsOf(thread);
  const author = facts?.author ?? null;
  const isViewer = author !== null && author.toLowerCase() === context.viewerLogin?.toLowerCase();

  return {
    kind: kindByType.get(thread.subjectType) ?? null,
    repo: thread.repository,
    org: thread.repository.split('/')[0] ?? null,
    author,
    me: isViewer ? '@me' : null,
    reason: thread.reason,
    state: facts?.state ?? null,
    new: String(context.isNew(thread)),
    unread: String(thread.unread),
  };
};

const typedValueFields: FilterField[] = ['repo', 'org', 'author', 'reason', 'age', 'title'];

const candidateFields: { field: FilterField; key: string }[] = [
  { field: 'kind', key: 'kind' },
  { field: 'repo', key: 'repo' },
  { field: 'org', key: 'org' },
  { field: 'author', key: 'author' },
  { field: 'author', key: 'me' },
  { field: 'reason', key: 'reason' },
  { field: 'state', key: 'state' },
  { field: 'new', key: 'new' },
  { field: 'unread', key: 'unread' },
];

export const filterCandidates = (
  threads: NotificationThread[],
  context: FilterCandidateContext,
): { fields: FilterField[]; values: FilterCandidate[] } => {
  const counts = new Map<string, FilterCandidate>();

  for (const thread of threads) {
    const values = factValues(thread, context);

    for (const { field, key } of candidateFields) {
      const value = values[key];

      if (value === null || value === undefined) {
        continue;
      }

      const id = `${field}:${value}`;
      const entry = counts.get(id) ?? { field, value, count: 0 };

      entry.count += 1;
      counts.set(id, entry);
    }
  }

  return { fields: typedValueFields, values: [...counts.values()] };
};
