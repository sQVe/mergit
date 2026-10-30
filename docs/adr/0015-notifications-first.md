# ADR 0015: Notifications first, with a batched subject lookup

**Date**: 2026-10-05\
**Status**: Accepted\
**Supersedes**: [ADR 0012: Sources find candidates, local rules decide why](./README.md#retired)\
**Related**: [ADR 0016: A SQLite snapshot with a checked full refresh](./0016-snapshot-and-full-refresh.md),
[GitHub notifications API](https://docs.github.com/en/rest/activity/notifications)

## Context

An earlier plan combined notifications with three pull request searches, and local rules that decide
why a pull request needs action.

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

- A thread is done when GitHub shows it as done, or when Mergit marked it done and its `updated_at`
  has not changed since. Mergit saves that record in local state under
  [ADR 0009](./0009-local-state-and-config.md).
- Done is the only action, on one thread or a group. Mergit sends it after a short delay so undo can
  cancel it, because the API cannot return a thread to the inbox. Dismiss, mark read, and
  unsubscribe are dropped.

### Subject facts

- For pull request and issue threads, Mergit looks up state and author in batched GraphQL requests,
  only for new or changed threads. A failed lookup leaves the fact unknown, and an unknown fact
  never hides a thread.
- `work` owns the facts type, and only `github` sees GitHub's response shapes.

### Subject detail

- The reader loads issue and pull request detail through GraphQL only for the subject it shows, so
  reads follow what the user is looking at. Pull request reads load only the visited tab: Overview,
  Commits, Checks, or Files. Other subject types show unsupported coverage and send no request.
- Refresh in the reader refreshes the feed and revalidates the shown subject, even when its
  notification is unchanged, because an edited comment does not change the thread's `updated_at`. A
  shown subject is revalidated again once its content goes stale. Cached subjects get no background
  refresh.
- Each source shows its own coverage. Partial or failed content never reads as complete. Content
  loaded before a stop or failure stays, marked partial, so a truncated discussion never looks full.
- A detail failure never changes the feed, so a failed subject read never hides or reorders threads
  the feed returned.

## Consequences

### Positive

- One source and no reason rules make the first version much smaller.
- Opening a thread never removes it.

### Negative

- Pull request work without a notification, such as a failed check on the user's own pull request,
  does not show.
- Done detection relies on undocumented fields.
- A thread read and then marked done outside Mergit stays until it is marked done in Mergit.
- `all=true` is larger than the unread feed: 362 threads against 81 in the sampled account.
- A long discussion shows partial coverage once a load reaches its limits.

## Alternatives considered

### Pull request searches with reason rules

Add three pull request searches, and local rules that decide why each item needs action. Deferred
because pull request work comes after the notification list proves useful.

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
