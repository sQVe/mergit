# ADR 0020: Field filters from a composer, applied on Enter

**Date**: 2026-10-14\
**Status**: Accepted\
**Related**: [ADR 0006: One command catalog as data](./0006-command-catalog.md),
[ADR 0019: Plain text search on `/`](./0019-search-and-field-filters.md),
[GitHub issue filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)

## Context

Users need field filters to cut a long inbox down. A list of values that exist in the inbox cannot
express an age such as `age:>3d`, a pattern such as `author:*[bot]`, a negation, or a value that is
not in the inbox.

The list must not change while the user types, because half-typed input is mostly invalid.

Some fields hold one value per thread, such as its repository, because a thread can never be in two
repositories. Others can match several chips at once: two bounds on `age` form a range, and a title
holds many words. GitHub's issue search treats them the same way: repeated `repo:` qualifiers widen,
and repeated `label:` qualifiers narrow.

## Decision

Filters are `field:value` tokens that the user types or picks with completion in a composer opened
with `f`. Each valid token becomes a chip when the user presses `Enter`, and the list changes only
then.

`Enter` that adds or replaces a chip closes the composer. `Enter` on an active chip removes it and
keeps the composer open, so the user can remove several chips in a row.

### Tokens

- A leading `-` negates a token. An unknown field name or a bad value is an error that names the
  problem, and `Enter` adds nothing.
- Mergit accepts GitHub spellings as aliases and shows them in its own spelling: `is:pr` becomes
  `kind:pr`, and `reason:review-requested` becomes `reason:review_requested`. GitHub users already
  type these, and one stored spelling keeps equal filters equal.
- `repo:`, `org:`, and `author:` match exactly, or with one `*` as a wildcard. `age:` takes `<` or
  `>` and a number with a unit. `title:` matches text the title contains.
- Several tokens in one entry add one chip each, only when all are valid. This lets the user paste
  filters.
- A filter prints as `field:value` text, so saved views can store it later.

### Logic

- Positive chips of one field combine with AND when one thread can match more than one of them, and
  with OR when it can match only one.
- `age` and `title` combine with AND, so two ages form a range and two title chips ask for both
  words. `repo`, `org`, `author`, `reason`, `kind`, `state`, `new`, and `unread` combine with OR,
  because AND on two values of a one-value field would always match nothing.
- Different fields combine with AND. Each negated chip excludes on its own. `/` text and filters
  combine with AND.
- Each term is true, false, or unknown, and a thread shows unless a term is false. An unknown fact
  never hides a thread. A release has no author, so `-author:*[bot]` keeps it.
- A bot author reads as `login[bot]`, as GitHub shows it, so one pattern matches every bot.

### Chips

- Chips show in one row above the list, grouped by field. Positive chips of one field are joined by
  the word the rule uses, `and` or `or`, so the list's meaning is visible. Negated chips stand
  apart.
- A chip is edited by copying it to the line. The old chip stays applied until `Enter` replaces it,
  so the list does not widen between removing and retyping. `F` clears all filters.

## Consequences

### Positive

- The list changes only on `Enter`, so it never jumps through valid prefixes.
- One candidate list serves filters now and can serve other input lines later.
- Typed values, wildcards, ages, and negation need no second mechanism.
- Two positive chips of a one-value field widen the list instead of matching nothing, and ranges of
  age need no new syntax.

### Negative

- A filter takes more keys than picking from a list: type a token, then `Enter`.
- `query.ts` again owns a parser, for one token at a time.
- OR across fields and parentheses are not possible. Repeated chips cover a list of values for one
  field.
- Users must learn that two fields narrow while two values of one field may widen, and the chip bar
  must show which.
- A new field must state whether a thread holds one value or many.

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

Pick filters from a list of values that exist in the inbox. Rejected because it cannot express ages,
patterns, or values outside the inbox. Revisit only if typed values prove confusing.

### Updating the list when a token becomes valid

Apply a token as soon as it parses. Rejected because the list jumps through valid prefixes, such as
`age:>3` before `age:>3d`. Revisit only if users find `Enter` too slow.

### One rule for chips of one field

Combine positive chips of one field with OR for every field, or with AND for every field. Rejected
because OR cannot express ranges of age or titles with several words, and AND on two chips of a
one-value field, such as two repositories, would always show nothing.

### A setting per field

Let the user choose AND or OR for each field. Rejected because the useful choice follows from the
field, and the other choice either matches nothing or cannot express a range.
