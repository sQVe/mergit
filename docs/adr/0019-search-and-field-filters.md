# ADR 0019: Plain text search on `/`, field filters from a picker

**Date**: 2026-10-14\
**Status**: Accepted\
**Supersedes**: [ADR 0017: GitHub-style qualifiers, evaluated locally](./0017-local-query-language.md)\
**Related**:
[ADR 0004: Capability modules with an enforced import table](./0004-capability-modules.md)

## Context

ADR 0017 put a typed query language on the `/` line. Every key press produced a new query, and most
half-typed queries were invalid. To keep the list stable, the parser fell back to the last valid
part of the query and showed an error row. Each fallback rule needed another rule for the next
half-typed case, so the list still changed under the user while they typed a field.

The notifications feed takes no query, so Zeta still evaluates every filter itself.

## Decision

The `/` line is plain text search, and field filters come from a picker of complete values.

### Search

- A thread matches when its title or repository contains every whitespace-separated word, ignoring
  case. Blank text means no search.
- Zeta never parses the text. `repo:` is the text `repo:`, so no input is invalid and the line has
  no error row.
- Backspace on an empty line closes it with no text applied.

### Filters

- A filter is a complete `field: value` pair chosen from a list of values that exist in the inbox,
  so a half-typed filter cannot exist.
- Search and filters are one query tree of terms combined with AND. `evaluate` in `query.ts` checks
  the tree with true, false, and unknown, and a thread shows unless a term is false. Only a known
  fact can hide a thread.

## Consequences

### Positive

- The list changes only for text the user typed, so it never jumps while they type.
- The line needs no error handling, and `query.ts` loses its tokenizer, parser, and fallback rules.
- Filters reuse the same tree and rules, so search and filters combine without a second path.

### Negative

- The user cannot type `is:pr` or `OR` on the line. Field filters need the picker.
- Saved views need their own text form for filters, to be decided when they are built.

## Alternatives considered

### The typed query language on `/`

Keep ADR 0017's language and add more fallback rules. Rejected because half-typed input kept
changing the list, and each fix added another parser rule.

### Jump-to-match search

Keep the full list and move the selection to the next match. Rejected because it does not narrow the
list, and bulk actions on a group need the narrowed set of threads.
