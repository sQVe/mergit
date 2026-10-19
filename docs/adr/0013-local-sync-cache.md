# ADR 0013: Hand-written sync over a SQLite cache

**Date**: 2026-10-03\
**Status**: Superseded\
**Superseded by**: [ADR 0016](./0016-snapshot-and-full-refresh.md)\
**Related**: [GitHub notifications API](https://docs.github.com/en/rest/activity/notifications),
[TanStack DB SQLite persistence](https://tanstack.com/db/latest/docs/guides/sqlite-persistence),
[TinyBase Bun SQLite persister](https://tinybase.org/api/persister-sqlite-bun/functions/creation/createsqlitebunpersister/)

## Context

GitHub tools that fetch everything on each start feel slow. Mergit should show work at once and then
bring it up to date.

GitHub is the source of truth, and Mergit controls no sync server. GitHub sends no change events,
and a search never reports the items that left it.

`GET /notifications` answers `If-Modified-Since` with a 304 that GitHub says does not count against
the rate limit. It asks clients to wait `X-Poll-Interval` seconds between polls. GraphQL search
accepts `updated:>TIMESTAMP` with sorting by update time.

Actions such as marking a notification read should show their result at once, not after the next
refresh.

Zero and Electric need a sync server we control. Replicache expects a browser. LiveStore syncs with
its own backend. TanStack DB and TinyBase run on Bun, but neither fetches GitHub changes or finds
removed items for us.

## Decision

The session store syncs GitHub data itself and keeps a disposable cache in SQLite. The
GitHub-specific work is custom in every option, and this keeps one owner for state without a
dependency.

### Cache

- The cache lives at `$XDG_CACHE_HOME/mergit/cache.db` and falls back to `~/.cache/mergit/cache.db`.
  It uses `bun:sqlite`. `localState.ts` owns it, and its functions reach the session as an injected
  record.
- Rows are scoped by host and account. Mergit never shows rows from another account.
- The cache holds item facts, which source found each item, and the validators and watermarks for
  the next fetch.
- The cache is disposable. When it is corrupt or has an unknown schema version, Mergit deletes it
  and fetches again. It never holds dismissals or anything else a user would lose.
- Writes run in transactions, one at a time.

### Sync

- On start, Mergit shows the cached items with their age, then refreshes.
- Notifications send `If-Modified-Since` and wait at least `X-Poll-Interval` between polls. A manual
  refresh fetches without the validator.
- Searches fetch only items updated since the last watermark. A watermark or validator is saved only
  after every page of its response arrived.
- Search results never show removals. A periodic full fetch of each source, and a check of the
  cached items it no longer returns, removes closed items and lapsed review requests.
- The refresh rules in [ADR 0005](./0005-session-store.md) still apply: one refresh at a time,
  generations, and a pause at the rate limit.

### Optimistic actions

- Marking read, marking done, and unsubscribing are optimistic. Dismissing already takes effect at
  once under [ADR 0009](./0009-local-state-and-config.md).
- An optimistic action adds an overlay keyed by its action ID. The snapshot shows facts with the
  overlays applied.
- When the request fails, Mergit removes that overlay and shows the error. Other overlays and newer
  facts stay.
- When the request succeeds, the overlay stays until a fetch returns facts that agree with it.
- Overlays live in memory only. A pending action is lost on restart, and there is no offline queue.

## Consequences

### Positive

- Mergit shows work from the cache before the network answers.
- Most polls send small or unchanged responses, and unchanged notification polls cost no rate limit.
- Actions show their result at once and roll back alone on failure.
- No new dependency, and the session store stays the one owner of state.

### Negative

- Mergit owns sync, removal checks, overlays, and their race tests.
- Between full fetches, an item that left a search can stay visible.
- No guarantee was found that every check change updates a PR's `updatedAt`, so check status can lag
  until the next full fetch.
- A pending action is lost when Mergit exits before it finishes.

## Alternatives considered

### Full refresh without a disk cache

Fetch everything on each refresh and keep nothing on disk. Rejected because start waits on the
network, and every poll costs full requests.

### TanStack DB

Use TanStack DB. Rejected because its optimistic rollback works on Bun, but its disk store needs
`better-sqlite3`, and the GitHub fetching and removal checks stay custom. It would replace the
session store.

### TinyBase

Use TinyBase. Rejected because it stores data on `bun:sqlite`, but rollback covers only local
changes. A failed GitHub call still needs custom code.

### LiveStore, RxDB, Replicache, Zero, or Electric

Use LiveStore, RxDB, Replicache, Zero, or Electric. Rejected because each expects a sync protocol or
server that GitHub does not provide.
