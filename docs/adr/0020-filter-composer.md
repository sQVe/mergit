# ADR 0020: Field filters from a composer, applied on Enter

**Date**: 2026-10-14\
**Status**: Accepted; the rule for chips of one field superseded by
[ADR 0021: Chips of one field combine by how many values a thread holds](./0021-chip-logic-by-field.md)\
**Supersedes**:
the Filters section of
[ADR 0019: Plain text search on `/`, field filters from a picker](./0019-search-and-field-filters.md)\
**Related**:
[ADR 0006: One command catalog as data](./0006-command-catalog.md)

## Context

ADR 0019 allowed only filters picked from a list of values that exist in the inbox. That list cannot
express an age such as `age:>3d`, a pattern such as `author:*[bot]`, a negation, or a value that is
not in the inbox. Users need these to cut a long inbox down.

The rule from ADR 0019 still holds: the list must not change while the user types, because
half-typed input is mostly invalid.

## Decision

Filters are `field:value` tokens that the user types or picks with completion in a composer opened
with `f`. Each valid token becomes a chip when the user presses `Enter`, and the list changes only
then.

### Tokens

- A leading `-` negates a token. An unknown field name or a bad value is an error that names the
  problem, and `Enter` adds nothing.
- Zeta accepts GitHub spellings as aliases and shows them in its own spelling: `is:pr` becomes
  `kind:pr`, and `reason:review-requested` becomes `reason:review_requested`. GitHub users already
  type these, and one stored spelling keeps equal filters equal.
- `repo:`, `org:`, and `author:` match exactly, or with one `*` as a wildcard. `age:` takes `<` or
  `>` and a number with a unit. `title:` matches text the title contains.
- Several tokens in one entry add one chip each, only when all are valid. This lets the user paste
  filters.
- A filter prints as `field:value` text, so saved views can store it later.

### Logic

- Positive chips of one field combine with OR, and different fields combine with AND. Each negated
  chip excludes on its own. `/` text and filters combine with AND.
- An unknown fact never hides a thread, as in ADR 0019. A release has no author, so `-author:*[bot]`
  keeps it.
- A bot author reads as `login[bot]`, as GitHub shows it, so one pattern matches every bot.

### Chips

- Chips show in one row above the list, grouped by field. Positive chips of one field are joined by
  `or`, so it is clear that they widen the list. Negated chips stand apart.
- A chip is edited by copying it to the line. The old chip stays applied until `Enter` replaces it,
  so the list does not widen between removing and retyping. `F` clears all filters.

## Consequences

### Positive

- The list changes only on `Enter`, so it never jumps through valid prefixes.
- One candidate list serves filters now and can serve other input lines later.
- Typed values, wildcards, ages, and negation need no second mechanism.

### Negative

- A filter takes more keys than picking from a list: type a token, then `Enter`.
- `query.ts` again owns a parser, for one token at a time.
- OR across fields and parentheses are not possible. Repeated chips cover a list of values for one
  field.

## Alternatives considered

### A filter query line applied on Enter

One line holds all filters, with OR and groups. Rejected because it needs a full parser, completion
that knows the cursor position, and an error row. Revisit if users need OR across fields or
parentheses.

### Completion that inserts tokens into editable text

Completion writes tokens into the line, and chips render them. Rejected because chips and text must
stay in sync, and typing outside completion still half-types a filter. Revisit only together with
the filter query line.

### Picking inbox values only

Keep ADR 0019's list of inbox values. Rejected because it cannot express ages, patterns, or values
outside the inbox. Revisit only if typed values prove confusing.

### Updating the list when a token becomes valid

Apply a token as soon as it parses. Rejected because the list jumps through valid prefixes, such as
`age:>3` before `age:>3d`. Revisit only if users find `Enter` too slow.
