# ADR 0019: Plain text search on `/`

**Date**: 2026-10-14\
**Status**: Accepted\
**Supersedes**: [ADR 0017: GitHub-style qualifiers, evaluated locally](./README.md#retired)\
**Related**: [ADR 0004: Capability modules with an enforced import table](./0004-capability-modules.md),
[ADR 0020: Field filters from a composer, applied on Enter](./0020-filter-composer.md)

## Context

The `/` line narrows the notification list as the user types. A typed query language on that line
made every key press produce a new query, and most half-typed queries were invalid. To keep the list
stable, the parser fell back to the last valid part of the query and showed an error row. Each
fallback rule needed another rule for the next half-typed case, so the list still changed under the
user while they typed a field.

The notifications feed takes no query, so Mergit evaluates every search and filter itself.

## Decision

The `/` line is plain text search. Field filters come from a separate composer, under
[ADR 0020](./0020-filter-composer.md).

### Search

- A thread matches when its title or repository contains every whitespace-separated word, ignoring
  case. Blank text means no search.
- Mergit never parses the text. `repo:` is the text `repo:`, so no input is invalid and the line has
  no error row.
- Backspace on an empty line closes it with no text applied.
- Search text and filters combine with AND.

### Query module

`query.ts` is a flat module that owns the query tree, its evaluation, and the filter token parser.
It imports `work` and `invariant`, and only `session` imports it.

## Consequences

### Positive

- The list changes only for text the user typed, so it never jumps while they type.
- The line needs no error handling, tokenizer, or fallback rules.
- Search and filters share one query tree, so they combine without a second path.

### Negative

- The user cannot type `is:pr` or `OR` on the line. Field filters need the composer.

## Alternatives considered

### A typed query language on `/`

Use GitHub's qualifier shape on the `/` line, such as `is:open author:@me`, with `OR`, parentheses,
and fallback rules for half-typed input. Rejected because half-typed input kept changing the list,
and each fix added another parser rule.

### Jump-to-match search

Keep the full list and move the selection to the next match. Rejected because it does not narrow the
list, and bulk actions on a group need the narrowed set of threads.
