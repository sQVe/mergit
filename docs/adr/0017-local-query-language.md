# ADR 0017: GitHub-style qualifiers, evaluated locally

**Date**: 2026-10-05\
**Status**: Superseded\
**Superseded by**:
[ADR 0019: Plain text search on `/`, field filters from a picker](./0019-search-and-field-filters.md)\
**Related**:
[ADR 0004: Capability modules with an enforced import table](./0004-capability-modules.md),
[GitHub issue filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests),
[GitHub inbox filters](https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters)

## Context

The `/` query line narrows the notification list as the user types. Saved views come later and will
reuse the same language.

The notifications feed takes no query, so Zeta evaluates every query itself.

The user already types GitHub search, such as `is:open author:@me`. GitHub's issue filters now
support `AND`, `OR`, and parentheses, and its notification inbox uses the same qualifier shape.

A survey of 24 filter languages, from issue trackers, terminal tools, and log search, pointed to
this shape.

## Decision

The query language uses GitHub's qualifier shape, evaluated locally. Zeta never sends it to GitHub.
The language is short and familiar, with one syntax for the query line and saved views.

### Query rules

- Plain words match title and repository. `field:value` matches a field, and `-` negates.
- A space means AND. `OR` and parentheses work as in GitHub's issue filters. A comma inside one
  qualifier means OR.
- `@me` is the viewer. `is:` is an alias for `kind:`, `state:`, and `new:`.
- A value must be complete. Zeta offers completion, but never matches a prefix.
- Half-typed input shows the result of the query without its unfinished term, so the partial words
  typed on the way to a field never decide the list. An invalid query shows its error at a position
  and never shows an empty list in its place.
- Each term is true, false, or unknown. A thread shows when the whole query is true or unknown, so
  only a known fact can hide it.

### Parser ownership

The parser is written by hand in a flat `query.ts` module. It imports `work` and `invariant`, and
only `session` imports it.

## Consequences

### Positive

- The common queries take a few keys, and the user already knows the syntax.
- Part of a query can run on GitHub search later, after a compile step.

### Negative

- The line looks like GitHub search but adds local fields such as `new` and `age`, which GitHub
  would not accept.
- Zeta owns a parser, its errors, and completion.

## Alternatives considered

### A perles-style language

Use a perles-style language, `field = value and ... order by ...`. Rejected because common queries
take more keys, and plain text is not a valid query, so typing errors before the first operator.

### Lucene or KQL through a library

Use Lucene or KQL through a library. Rejected because `liqe` failed on values such as
`repo:sqve/zeta` and gives no error position for half-typed input.

### An expression language

Use an expression language such as CEL. Rejected because it is too verbose to type.

### Text match only

Use text match only. Rejected because it cannot hide releases or filter by reason or state.
