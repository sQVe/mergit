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
