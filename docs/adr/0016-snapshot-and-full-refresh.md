# ADR 0016: A SQLite snapshot with a checked full refresh

**Date**: 2026-10-05\
**Status**: Accepted\
**Related**: [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

## Context

[ADR 0013](./0013-local-sync-cache.md) chose incremental sync with watermarks and removal checks for
pull request searches. [ADR 0015](./0015-notifications-first.md) removes those searches.

The notifications feed pages at 50 threads, sorted by update time. A 304 costs no rate limit.

`If-Modified-Since` compares only the newest `updated_at`, so it misses threads that left the feed.
A page's ETag changes with its content.

`gh` shares the user's rate limit with the user's agents and other tools.

## Decision

SQLite holds a start-up snapshot, and polls check page 1 with its ETag. A full refresh checks every
page with its ETag, on change or on a timer. An unchanged poll costs one free request.

### Refresh

- A full refresh runs on start, when page 1 changed, every 10 minutes, and after a done.
- The snapshot saves each page's body with its ETag, so an unchanged restart costs no rate limit.
- A refresh that did not get every page changes nothing. A complete refresh replaces the item set.
- Pages shift when threads come or go during a refresh. So a refresh ends by checking every page
  again with its new ETag, and replaces the item set only when every page answers 304. Otherwise it
  changes nothing and runs again.
- Mergit never caps the page count, because a cap would hide threads that are not done.
- The snapshot lives in `$XDG_CACHE_HOME/mergit/cache.db`, scoped by host and account, and is
  disposable.
- Polling follows `X-Poll-Interval`, `Retry-After`, and the refresh rules of
  [ADR 0005](./0005-session-store.md).

## Consequences

### Positive

- Mergit shows the snapshot before the network answers, and removals need no code of their own.

### Negative

- A thread marked done outside Mergit can stay up to 10 minutes.
- At 2,000 threads, a busy hour can use about half the user's REST limit.
- Two Mergit processes poll on their own and double the requests.
- Each full refresh requests every page twice. The second pass is free when nothing moved.

## Alternatives considered

### Keep ADR 0013

Keep ADR 0013. Rejected because its watermarks and removal checks served the searches.

### `If-Modified-Since` polling

Use `If-Modified-Since` on each poll. Rejected because threads marked done elsewhere never leave.

### Check every page each minute

Check every page with its ETag each minute. Rejected because at 2,000 threads that is 40 requests
and about 25 s every minute.

### `since` with a periodic full fetch

Use `since` plus a periodic full fetch. Deferred because it cannot see removals, and a probe showed
it skip a thread updated after the cutoff.
