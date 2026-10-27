# ADR 0011: GitHub through `gh api`

**Date**: 2026-10-03\
**Status**: Accepted\
**Related**: [ADR 0016: A SQLite snapshot with a checked full refresh](./0016-snapshot-and-full-refresh.md),
[`gh api` manual](https://cli.github.com/manual/gh_api),
[GitHub GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api),
[GitHub notifications API](https://docs.github.com/en/rest/activity/notifications),
[gh-dash GraphQL queries](https://github.com/dlvhdr/gh-dash/blob/main/internal/data/prapi.go#L508-L595),
[lazygit GitHub token lookup](https://github.com/jesseduffield/lazygit/blob/master/pkg/commands/git_commands/github.go#L165-L301)

## Context

Mergit needs the notifications feed, plus the state and author of the pull requests and issues those
threads point to, across many repositories.

`gh pr view` and `gh issue view` return one subject per process. One GraphQL query can look up many
subjects across repositories in one request, at a small point cost.

GraphQL has no notifications field. Notifications come only from the REST `GET /notifications`
endpoint.

Users already sign in with `gh`, which stores the token and switches accounts. A token that Mergit
keeps from startup misses a later `gh auth switch`.

## Decision

Mergit reads and writes GitHub by running `gh api`. Subject lookups use batched GraphQL queries, and
notifications use one REST call per page. Mergit names the GitHub host on every call. `gh` owns
authentication and the active account, and Mergit adds no dependency.

### Requests

- Subject lookups run as batched `gh api graphql` queries.
- Notifications use `gh api /notifications`, one call per page.
- Mergit never reads, stores, or passes a GitHub token. `gh` finds it, so `GH_TOKEN` and
  `gh auth switch` work as they do for `gh`.
- `gh` is a required tool. Mergit reports a clear error when `gh` is missing or not signed in.
- Each request starts a new `gh` process, so it uses the account that is active at that time.
- Every `gh api` call passes `--hostname HOST`, and every `gh browse` call passes
  `--repo HOST/OWNER/REPO`. The host selects a server, never an account. `gh` still picks the
  account and token for that host.
- Mergit picks the host once at startup, by the rule `gh` follows without `--hostname`. It uses
  `GH_HOST` when it is set and not empty. Otherwise it uses the only host that
  `gh auth status --json hosts` lists. In every other case it uses `github.com`: no host, several
  hosts, `gh` missing, a non-zero exit, output over the limit, or output that does not parse.
- Mergit reads at most a fixed number of bytes from each of the stdout and stderr streams of `gh`.
  It counts bytes while it reads. When a stream passes the limit, Mergit stops reading, ends the
  process with `SIGKILL`, and returns a size failure instead of the output.
- Every call runs with `--include`. Mergit reads the HTTP status and headers, and the GraphQL
  `errors` field, instead of the exit code. GraphQL can report a rate limit with HTTP 200, and `gh`
  exits 1 on a 304 Not Modified.

### Ownership

- Only the `github` module builds requests and parses their results. It passes plain work data to
  the rest of Mergit, so the transport can change without touching other modules.
- Actions that change GitHub, such as marking a notification read, also run `gh api` through the
  `github` module.

## Consequences

### Positive

- A refresh costs few processes and requests, at a small point cost.
- Mergit has no token handling and no HTTP client dependency.
- A large or endless response cannot fill Mergit's memory.

### Negative

- Mergit does not work without `gh` installed and signed in.
- Errors arrive as status lines, headers, and response text, which Mergit must parse, instead of
  typed HTTP errors.
- Mergit owns its GraphQL query and must follow GitHub schema deprecations.
- Cancellation kills the `gh` process instead of aborting a request.
- A valid response larger than the limit fails instead of loading.

## Alternatives considered

### `gh pr view` and `gh issue view`

Run `gh pr view` and `gh issue view` with `--json` for each subject. Rejected because a refresh
would start one process per pull request or issue.

### Bun `fetch`

Send requests with Bun `fetch` and a token from `gh auth token`. Rejected because Mergit would
handle tokens and hosts itself. It would gain little because a refresh sends few requests, and `gh`
stays required for the token.

### Octokit

Use Octokit. Rejected because it adds dependencies for a few requests that `gh` or `fetch` already
sends.
