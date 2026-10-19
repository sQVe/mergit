# ADR 0012: Sources find candidates, local rules decide why

**Date**: 2026-10-03\
**Status**: Superseded\
**Superseded by**: [ADR 0015](./0015-notifications-first.md)\
**Related**: [ADR 0011: GitHub through `gh api`](./0011-github-through-gh-api.md),
[ADR 0013: Hand-written sync over a SQLite cache](./0013-local-sync-cache.md)

## Context

Mergit shows GitHub work that needs action, with every reason for each item. It will grow more
sources and reasons later, so both must grow without a redesign.

The first version covers notifications, pull requests that request the viewer's review, the viewer's
own pull requests, and pull requests assigned to the viewer.

Notifications cover pull requests, issues, releases, check suites, discussions, and more. Their
payload has a title, type, and REST URL, but no node ID. Check suite notifications have no URL.

GitHub search cannot express some reasons, such as merge conflicts. Rules that need GitHub to test
are slow to test and hard to change.

## Decision

Sources decide which subjects Mergit fetches, and rules in `work` decide why each one needs action.
Sources are a list that returns candidates, and named local rules run over plain facts. Sources and
rules each grow by adding an entry, and the rules run in tests without GitHub.

### Sources

- A source has a name and finds candidate subjects. The first sources are unread notifications and
  three pull request searches: `review-requested:@me`, `author:@me`, and `assignee:@me`, each open
  only.
- A subject found by several sources becomes one item.
- Sources are one list in `github`. Adding a source means adding an entry.

### Identity

- An item's identity is its host, repository, subject type, and number or ID, such as a pull request
  number or release ID.
- A notification without a subject URL, such as a check suite, uses its thread ID as its identity.

### Rules

- A rule has a stable ID and a pure function from the facts of one item to a reason or none.
- `work` holds the rules as one list. Adding a reason means adding an entry, not changing callers.
- Rules read facts, not which source found the item. "Review requested" checks the review requests,
  so the result does not depend on how the sources overlap.
- An unread notification is a reason by itself, with GitHub's notification reason as its detail.
- A candidate with no reason is not shown.

### Facts

- `work` owns the facts type. `github` fills it from responses. Rules never see GraphQL or REST
  shapes.
- Facts for a subject type that Mergit cannot look up in a batch, such as a check suite, stay at
  what the notification payload holds.
- A rule that needs a new fact adds it to the facts type and to the query in the same change.

## Consequences

### Positive

- New sources and reasons need no change to the session, UI, or transport.
- Every rule runs in unit tests with plain fact values.

### Negative

- Every refresh fetches every fact any rule reads.
- Items of subject types without detail lookups show only a title and a type.
- Changing a source or rule still needs a code change until config supports it.
- Each search is capped by GitHub search limits.

## Alternatives considered

### One search query per reason

Use one search query per reason, so GitHub does the filtering. Rejected because some reasons cannot
be searched, and the rules would live in query strings that tests cannot check without GitHub.

### Sources and rules in config

Put sources and rules in config from the start. Deferred because the basic sources come first, and
the chosen structure lets config add them later without a redesign.

### User-written rule code

Load user-written rule code at runtime. Deferred because it needs a plugin contract and a trust
model.
