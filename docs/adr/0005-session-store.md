# ADR 0005: One session store outside React

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0004: Capability modules with an enforced import table](./0004-capability-modules.md),
[gh-dash PR #746](https://github.com/dlvhdr/gh-dash/pull/746),
[Gemini CLI issue #27844](https://github.com/google-gemini/gemini-cli/issues/27844)

## Context

Refresh timers, child processes, and file writes must keep running while components mount and
unmount, and shutdown must stop them without React.

lazygit and gh-dash run refresh outside their view layer. The surveyed OpenTUI apps use several
state models, and none needs a store library.

gh-dash PR #746 shows a cache that made manual refresh show stale reviewer status. lazygit waits for
one poll to finish before the next and drops results from an older refresh.

A slow network call should not delay the first frame. Gemini CLI issue #27844 reports network work
that delayed a local prompt.

## Decision

The `session` module owns one hand-written store for application state outside React. React reads it
with `useSyncExternalStore`. The store is one owner for state and operation lifetime, which headless
tests drive the same way production does.

### Store

- The store exposes `getSnapshot`, `subscribe`, `send`, and `stop`. `getSnapshot` returns the same
  object until a transition changes state.
- Transitions are pure. They receive events and facts, including the current time, and return the
  next snapshot.
- The UI sends intents. It does not change application state directly.
- The session owns the list viewport, and React keeps focus, modal, and overlay scroll state.
- The snapshot holds one item per notification thread, with its notification reason. Selection and
  done use the thread ID.

### Refresh

- The UI mounts before the first fetch starts.
- One refresh runs at a time. Timer requests during a refresh are dropped. A manual request during a
  refresh schedules one follow-up refresh.
- The next poll is scheduled after the current refresh finishes, never on a fixed interval that can
  overlap.
- Each refresh carries a generation. A result from an older generation, or after `stop`, is dropped.
- A failed refresh keeps the previous items and shows the error.
- One pause covers every GitHub read. A rate limit from the feed, a subject lookup, or a detail
  read, including a GraphQL limit reported with HTTP 200, pauses feed refreshes, subject lookups,
  and detail reads until the reset time. The pause gates the start of a read. A refresh that already
  started finishes. Manual refresh does not bypass the pause.
- Cached data and its sync follow [ADR 0016](./0016-snapshot-and-full-refresh.md). A manual refresh
  skips the stored feed ETags.

### Detail

- The session owns the detail of the subject the reader shows. Each load carries a generation for
  its host, account, and subject. A page is accepted only from the latest load of its subject, when
  no account change happened since the load started, and when its viewer ID equals the feed's
  viewer. Showing another subject aborts the loads of every other subject.
- A page from another viewer clears all detail content and names that account in the snapshot.
- Detail is cached per notification thread, because a renamed repository's name and number can later
  name another subject. The first read looks the subject up by repository and number. Later reads
  use the node ID it returned, and a page with another node ID never merges into that entry.
- An account change and `stop` abort every detail load and clear all detail content, tabs, and
  anchors. Detail lives in memory only and is never saved.
- Each subject keeps its tab and text anchor in memory across visits. The cache holds 20 subjects or
  32 MiB of bodies and anchors, and evicts the subject shown longest ago. It never evicts the shown
  subject. The shown subject keeps whole comments up to 32 MiB and drops the rest with partial
  coverage.
- Detail reads run at most two `gh` processes at a time. A process counts until it settles, even
  after an abort. A read checks the pause when it gets its process, so a read that waited for a
  process during a pause does not start.

### Actions

- An action captures its item and destination when it starts. A later refresh does not retarget it.
- Actions run one at a time. Completions for an inactive action or a stopped session are ignored.

## Consequences

### Positive

- Polling, actions, and shutdown have one owner that does not depend on React.
- Tests drive the store with fake functions and a fake clock, without a renderer.

### Negative

- A hand-written store needs its own tests for subscription and snapshot identity.
- Every subscriber renders on each snapshot change. Selectors wait for measured contention.

## Alternatives considered

### React state

Use React state with `useReducer` and context. Rejected because operation lifetime would live in
effects, or need a second coordinator outside React.

### A store library

Use a store library such as Zustand, or Effect atoms. Rejected because a small hand-written store
covers one session, and no measured render contention calls for selectors.

### A generic event bus

Use a generic event bus. Rejected because it hides who owns each state change.
