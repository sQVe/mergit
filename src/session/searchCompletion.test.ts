import { expect, test } from 'bun:test';

import { chosenCandidateIndexOf, searchCandidatesOf } from './searchCompletion.ts';
import { makeHarness, makeThread } from './sessionHarness.ts';
import { matchCountOf } from './sessionState.ts';

const threads = () => [
  makeThread('1', { title: 'Fix parser', repository: 'hups-co/platform' }),
  makeThread('2', { title: 'Plan lexer', repository: 'hups-co/platform' }),
  makeThread('3', { title: 'Plan docs', repository: 'acme/app' }),
  makeThread('4', { title: 'Tidy', repository: 'acme/app' }),
];

const valuesOf = (snapshot: Parameters<typeof searchCandidatesOf>[0]): string[] =>
  searchCandidatesOf(snapshot).map((candidate) => candidate.value);

const open = async () => {
  const harness = makeHarness();

  await harness.load(...threads());
  harness.session.send({ kind: 'openSearch' });

  return harness.session;
};

test('pla offers the repository and title words, ranked by count then name', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'pla' });

  expect(valuesOf(session.getSnapshot())).toEqual(['hups-co/platform', 'plan']);

  expect(searchCandidatesOf(session.getSnapshot()).map((candidate) => candidate.count)).toEqual([
    2, 2,
  ]);
});

test('no candidates when the line is empty or ends in whitespace', async () => {
  const session = await open();

  expect(valuesOf(session.getSnapshot())).toEqual([]);

  session.send({ kind: 'editSearch', text: 'pla ' });

  expect(valuesOf(session.getSnapshot())).toEqual([]);
});

test('other words on the line narrow the counts', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'lexer pla' });

  expect(valuesOf(session.getSnapshot())).toEqual(['hups-co/platform', 'plan']);

  session.send({ kind: 'editSearch', text: 'docs pla' });

  expect(valuesOf(session.getSnapshot())).toEqual(['plan']);
});

test('Tab replaces the last word and the match count narrows at once', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'fix pla' });
  session.send({ kind: 'nextSearchCompletion' });

  expect(session.getSnapshot().searchText).toBe('fix hups-co/platform');

  session.send({ kind: 'editSearch', text: 'pla' });

  const typedCount = matchCountOf(session.getSnapshot());

  session.send({ kind: 'nextSearchCompletion' });

  const chosenCount = matchCountOf(session.getSnapshot());

  expect(session.getSnapshot().searchText).toBe('hups-co/platform');
  expect(chosenCount).toBe(2);
  expect(typedCount).toBeGreaterThan(chosenCount);
});

test('Tab and Shift-Tab cycle through the candidates of the typed text and wrap', async () => {
  const session = await open();
  const texts: string[] = [];

  session.send({ kind: 'editSearch', text: 'pla' });

  for (const kind of [
    'nextSearchCompletion',
    'nextSearchCompletion',
    'nextSearchCompletion',
    'previousSearchCompletion',
    'previousSearchCompletion',
  ] as const) {
    session.send({ kind });
    texts.push(session.getSnapshot().searchText);
  }

  expect(texts).toEqual([
    'hups-co/platform',
    'plan',
    'hups-co/platform',
    'plan',
    'hups-co/platform',
  ]);

  expect(valuesOf(session.getSnapshot())).toEqual(['hups-co/platform', 'plan']);
});

test('Shift-Tab first chooses the last candidate', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'pla' });
  session.send({ kind: 'previousSearchCompletion' });

  expect(session.getSnapshot().searchText).toBe('plan');
});

test('without a chosen candidate the list narrows by the typed text alone', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'pla' });

  expect(matchCountOf(session.getSnapshot())).toBe(3);
  expect(session.getSnapshot().searchCompletion).toBeNull();

  session.send({ kind: 'editSearch', text: 'plat' });

  expect(matchCountOf(session.getSnapshot())).toBe(2);
});

test('an edit, keep, or restore drops the choice', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'pla' });
  session.send({ kind: 'nextSearchCompletion' });
  session.send({ kind: 'editSearch', text: 'plan' });

  expect(session.getSnapshot().searchCompletion).toBeNull();

  session.send({ kind: 'editSearch', text: 'pla' });
  session.send({ kind: 'nextSearchCompletion' });
  session.send({ kind: 'keepSearch' });

  expect(session.getSnapshot().searchCompletion).toBeNull();

  session.send({ kind: 'openSearch' });
  session.send({ kind: 'editSearch', text: 'pla' });
  session.send({ kind: 'nextSearchCompletion' });
  session.send({ kind: 'restoreSearch' });

  expect(session.getSnapshot().searchCompletion).toBeNull();
});

test('Tab with no candidates changes nothing', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'zzz' });
  session.send({ kind: 'nextSearchCompletion' });

  expect(session.getSnapshot().searchText).toBe('zzz');
  expect(session.getSnapshot().searchCompletion).toBeNull();
});

test('the chosen candidate is readable by its index', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'pla' });

  expect(chosenCandidateIndexOf(session.getSnapshot())).toBeNull();

  session.send({ kind: 'nextSearchCompletion' });
  session.send({ kind: 'nextSearchCompletion' });

  expect(chosenCandidateIndexOf(session.getSnapshot())).toBe(1);
});

test('completion intents leave the snapshot unchanged while the line is closed', async () => {
  const session = await open();

  session.send({ kind: 'editSearch', text: 'pla' });
  session.send({ kind: 'keepSearch' });

  const before = session.getSnapshot();

  session.send({ kind: 'nextSearchCompletion' });
  session.send({ kind: 'previousSearchCompletion' });

  expect(session.getSnapshot()).toBe(before);
  expect(before.searchText).toBe('pla');
});

test('repository candidates keep their original case', async () => {
  const harness = makeHarness();

  await harness.load(makeThread('1', { title: 'Tidy', repository: 'Hups-Co/Platform' }));
  harness.session.send({ kind: 'openSearch' });
  harness.session.send({ kind: 'editSearch', text: 'pla' });
  harness.session.send({ kind: 'nextSearchCompletion' });

  const snapshot = harness.session.getSnapshot();

  expect(snapshot.searchText).toBe('Hups-Co/Platform');
  expect(matchCountOf(snapshot)).toBe(1);
});

test('when the list changes between Tabs the next Tab moves from the chosen value', async () => {
  const harness = makeHarness();
  const { session } = harness;

  await harness.load(
    makeThread('1', { title: 'plan plan plan' }),
    makeThread('2', { title: 'plan plant plate' }),
    makeThread('3', { title: 'plant plate' }),
    makeThread('4', { title: 'plate' }),
  );

  session.send({ kind: 'openSearch' });
  session.send({ kind: 'editSearch', text: 'pla' });
  session.send({ kind: 'nextSearchCompletion' });
  session.send({ kind: 'nextSearchCompletion' });

  const chosen = session.getSnapshot().searchText;

  expect(chosen).toBe('plan');

  await harness.load(
    makeThread('1', { title: 'plan plan plan' }),
    makeThread('2', { title: 'plan plant plate' }),
    makeThread('3', { title: 'plant plate' }),
    makeThread('4', { title: 'plate' }),
    makeThread('5', { title: 'place place place' }),
    makeThread('6', { title: 'place' }),
    makeThread('7', { title: 'place' }),
    makeThread('8', { title: 'place' }),
  );

  session.send({ kind: 'nextSearchCompletion' });

  const values = valuesOf(session.getSnapshot());
  const index = values.indexOf(chosen);

  expect(values).toContain('place');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(session.getSnapshot().searchText).toBe(values[(index + 1) % values.length] ?? '');
  expect(session.getSnapshot().searchText).not.toBe(chosen);
});

test('title words lose punctuation at both edges and keep digits', async () => {
  const harness = makeHarness();

  await harness.load(
    makeThread('1', { title: '((lexer re-render parser:)', repository: 'acme/app' }),
    makeThread('2', { title: '2fast fast2 (v3)', repository: 'acme/app' }),
  );

  harness.session.send({ kind: 'openSearch' });

  const offeredFor = (text: string): string[] => {
    harness.session.send({ kind: 'editSearch', text });

    return valuesOf(harness.session.getSnapshot());
  };

  expect(offeredFor('lex')).toEqual(['lexer']);
  expect(offeredFor('re-')).toEqual(['re-render']);
  expect(offeredFor('pars')).toEqual(['parser']);
  expect(offeredFor('fast')).toEqual(['2fast', 'fast2']);
  expect(offeredFor('v')).toEqual(['v3']);
});

test('a chosen value that drops out of the list has no index', async () => {
  const harness = makeHarness();
  const { session } = harness;

  await harness.load(...threads());
  session.send({ kind: 'openSearch' });
  session.send({ kind: 'editSearch', text: 'pla' });
  session.send({ kind: 'nextSearchCompletion' });
  session.send({ kind: 'nextSearchCompletion' });

  expect(session.getSnapshot().searchText).toBe('plan');
  expect(chosenCandidateIndexOf(session.getSnapshot())).toBe(1);

  await harness.load(makeThread('1', { title: 'Fix parser', repository: 'hups-co/platform' }));

  expect(valuesOf(session.getSnapshot())).not.toContain('plan');
  expect(chosenCandidateIndexOf(session.getSnapshot())).toBeNull();
});
