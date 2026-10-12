# ADR 0015: Notifications first, with a batched subject lookup

**Date**: 2026-10-05\
**Status**: Accepted\
**Related**: [ADR 0016: A SQLite snapshot with a checked full refresh](./0016-snapshot-and-full-refresh.md),
[GitHub notifications API](https://docs.github.com/en/rest/activity/notifications)

## Context

[ADR 0012](./0012-work-sources-and-rules.md) planned notifications plus three pull request searches,
with local rules that decide why a pull request needs action.

After two design reviews, the user chose to ship the notification list first and prove daily value
before building pull request work.

In the sampled account, 29 of 39 pull request threads were on merged pull requests. The notification
payload holds neither the subject's state nor its author.

The user works toward inbox zero: a thread is done or not. Opening a thread in the browser marks it
read on GitHub, which must not count as done.

A test on 2026-10-05 showed that `GET /notifications?all=true` still returns done threads. A done
thread that was never read shows `unread: false` and `last_read_at: null`. A thread read before it
was marked done looks like any read thread.

A test on 2026-10-12 confirmed this. Done on a read thread changed no field in the feed, and Done on
an unread thread also marked it read. The web inbox sends Done as a form request to
`/notifications/beta/archive`, with the browser session and a CSRF token, and renders its list as
HTML. No API that a `gh` token can reach reports the done state.

## Decision

The only source is the notifications feed, read with `all=true`. Each thread that is not done is one
item, with GitHub's notification reason. Pull request searches and reason rules are deferred.

### Threads and actions

- A thread is done when GitHub shows it as done, or when Zeta marked it done and its `updated_at`
  has not changed since. Zeta saves that record in local state under
  [ADR 0018](./0018-local-state-and-config.md).
- Done is the only action, on one thread or a group. Zeta sends it after a short delay so undo can
  cancel it, because the API cannot return a thread to the inbox. Dismiss, mark read, and
  unsubscribe are dropped.

### Subject facts

- For pull request and issue threads, Zeta looks up state and author in batched GraphQL requests,
  only for new or changed threads. A failed lookup leaves the fact unknown, and an unknown fact
  never hides a thread.
- `work` owns the facts type, and only `github` sees GitHub's response shapes.

## Consequences

### Positive

- One source and no reason rules make the first version much smaller.
- Opening a thread never removes it.

### Negative

- Pull request work without a notification, such as a failed check on the user's own pull request,
  does not show.
- Done detection relies on undocumented fields.
- A thread read and then marked done outside Zeta stays until it is marked done in Zeta.
- `all=true` is larger than the unread feed: 362 threads against 81 in the sampled account.

## Alternatives considered

### Keep ADR 0012

Keep ADR 0012. Deferred because pull request work comes after the notification list proves useful.

### No subject lookup

Do no subject lookup. Rejected because threads on merged pull requests, most of the noise, look like
live ones.

### Unread threads only

Show unread threads only, so read means done. Rejected because opening a thread would remove it.

### Read state beside done

Show GitHub's read state beside done. Rejected because the user wants one state.

### Done from timestamps

Treat a read thread whose `updated_at` is later than its `last_read_at` as done. Rejected because
Done does not move `updated_at`, and on 2026-10-12 a thread still in the inbox matched this pattern.

### The web inbox

Read the done state from the web inbox. Rejected because it needs the user's browser session and an
undocumented HTML page that can change without notice.
