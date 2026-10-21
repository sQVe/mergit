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
- A rate-limit response pauses polling until the reset time. Manual refresh does not bypass the
  pause.
- Cached data and its sync follow [ADR 0016](./0016-snapshot-and-full-refresh.md). A manual refresh
  skips the stored feed ETags.

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
