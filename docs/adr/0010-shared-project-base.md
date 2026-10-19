# ADR 0010: One project base shared with Koja

**Date**: 2026-10-03\
**Status**: Accepted\
**Related**: [Seam](https://github.com/sQVe/seam)

## Context

Mergit and [Koja](https://github.com/sQVe/koja) are both Bun and TypeScript terminal apps with the
same maintainer. They use the same toolchain, CI, release flow, and house style.

When the two setups drift, each fix has to be found and made twice. Tooling that is set up a
different way in each repository also costs time when switching between them.

Only two repositories share the base, so tooling built only to keep them in sync costs more than
comparing files by hand.

## Decision

Mergit and Koja share one project base. A change to a shared file is made in both repositories.

The base is kept by convention. Shared lint code lives in `@sqve/seam`, and the other shared files
are compared by hand when one changes. This costs nothing to run, and the package holds the largest
shared part.

### What is shared

- House style comes from `@sqve/seam`. A lint rule that both projects need goes into Seam, not into
  either repository.
- Tooling and repository files stay the same in both repositories, except for the project name and
  description. This covers `package.json` scripts and tooling dependencies, TypeScript, Knip, and
  Changesets config, staged hooks, CI and release workflows, Renovate, Grove, and CodeRabbit config.
- The ADR process is shared: the ADR guide, the template, and the documentation scope in
  [ADR 0001](./0001-documentation-scope.md). The general rules in `AGENTS.md` match as well.

### What stays local

- Project rules live in one local lint plugin, `scripts/lintRules.ts`, and in `vite.config.ts` rules
  that refer to it or to Mergit's own dependencies.
- Runtime dependencies, ADRs after 0001, and the architecture section of `AGENTS.md` belong to each
  project.
- A shared decision, such as the runtime or the UI framework, gets an ADR in each repository. Each
  ADR keeps the reasons that apply to its own project.

## Consequences

### Positive

- A fix to tooling, CI, or house style is written once and copied as is.
- Moving between the repositories needs no relearning of commands or config.

### Negative

- Nothing catches drift. The author of a change to a shared file must remember to make it in the
  other repository.
- A tooling need that only one project has must either fit both repositories or stay a local
  exception.

## Alternatives considered

### Separate setups

Let each repository evolve its own setup. Rejected because drift builds up, and a fix in one
repository does not reach the other.

### A comparison script

Add a script that compares the shared files with a Koja checkout. Rejected because it works only
when both checkouts sit side by side, so CI cannot run it.

### A template repository

Generate both repositories from a template repository. Rejected because a template helps only when a
repository is created. Keeping two existing repositories in line adds a third repository to
maintain.
