# ADR 0021: Chips of one field combine by how many values a thread holds

**Date**: 2026-10-14\
**Status**: Accepted\
**Supersedes**: the rule for chips of one field in
[ADR 0020: Field filters from a composer, applied on Enter](./0020-filter-composer.md)

## Context

ADR 0020 combined positive chips of one field with OR. That fits fields where a thread holds one
value, such as its repository, because a thread can never be in two repositories. It fails for
`age`: `age:>7d age:<30d` widened the list to every thread instead of keeping a range, and a user
testing the composer expected a range. A thread's title also holds many words, so OR on two `title:`
chips cannot ask for both words.

## Decision

Positive chips of one field combine with AND when one thread can match more than one of them, and
with OR when it can match only one.

- `age` and `title` combine with AND. An age is a point on a scale, so two bounds form a range, and
  a title holds many words.
- `repo`, `org`, `author`, `reason`, `kind`, `state`, `new`, and `unread` combine with OR. A thread
  holds one value of each, so AND on two values would always match nothing.
- Different fields combine with AND, and each negated chip excludes on its own, as in ADR 0020.
- The chip bar joins chips with the word the rule uses, `and` or `or`, so the list's meaning is
  visible.

GitHub's issue search behaves the same way: repeated `repo:` qualifiers widen, and repeated `label:`
qualifiers narrow.

## Consequences

### Positive

- Every combination of two positive chips on one field can match something.
- Ranges of age and several title words need no new syntax.

### Negative

- Users must learn that two fields narrow while two values of one field may widen, and the chip bar
  must show which.
- A new field must state whether a thread holds one value or many.

## Alternatives considered

### OR for every field

Keep the rule from ADR 0020. Rejected because ranges of age and titles with several words cannot be
expressed.

### AND for every field

One rule everywhere. Rejected because two chips of a one-value field, such as two repositories,
would always show nothing, and picking several repositories is common.

### A setting per field

Let the user choose AND or OR for each field. Rejected because the useful choice follows from the
field, and the other choice either matches nothing or cannot express a range.
