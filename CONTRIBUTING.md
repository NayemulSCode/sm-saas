# Working in this repository

Written for a **1–2 developer team with no dedicated DevOps**. Every rule here
exists because it is cheap at that size. Anything that needs a third person to
enforce it has been left out deliberately.

## Branching — trunk-based, short-lived branches

`main` is always deployable. There is no `develop`, no release branch and no
GitFlow. With two people, long-lived branches produce merge pain that costs more
than the isolation is worth.

```
main ──────●────────────●────────────●──────▶
            \          /  \          /
             ●───●────●    ●───●────●
             feat/…-phase-2   feat/…-phase-3
```

| Prefix | Use for |
|---|---|
| `feat/<topic>-phase-N` | Planned roadmap work — matches the phase in the architecture docs |
| `fix/<topic>` | Bug fixes against shipped behaviour |
| `docs/<topic>` | Architecture and documentation only |
| `chore/<topic>` | Tooling, CI, dependencies |
| `spike/<topic>` | Throwaway investigation. **Never merged** — findings become an ADR |

Branch lifetime target: **under five days**. If a branch cannot land in a week,
it is too big — split it or merge it behind a feature flag.

## Commits

One line, imperative, sentence case, no type prefix. State what changed and, when
it is not obvious, what it fixes.

```
Add Phase 2 fee ledger with gapless receipt numbering
Fix absent marks being coerced to zero during tabulation
Drop schema-per-tenant in favour of RLS, and rewrite ADR-0003
```

Not `feat:`, not `chore(deps):`. Conventional Commits buys automated changelogs,
which this team does not generate, at the cost of noise in every log line.

The trailing `(#N)` is appended automatically by GitHub's squash merge — do not
write it by hand.

**Never commit:** `.env` files, database dumps, tenant data, student photos,
private keys. If a credential lands in history, rotate it. Removing the file is
not enough; the blob stays reachable in every clone that already fetched it.

## Pull requests

Every change reaches `main` through a PR, including your own solo work. The PR
is where the reasoning is recorded — six months from now the diff will not
explain itself.

- **Squash merge only.** `main` keeps one commit per PR and stays bisectable.
- Delete the branch after merge.
- Self-merge is fine when you are working alone. Still open the PR: the
  description is the audit trail, and the CI run is the safety net.
- A PR that changes a decision in `docs/architecture/` must update the ADR in
  the same PR. Architecture that drifts from the code is worse than none.

## Protected `main`

Configure once, in GitHub repository settings:

- Require a pull request before merging
- Require status checks to pass (`docs` now; `test`, `typecheck`, `build` once
  code exists)
- Require branches to be up to date before merging
- Block force pushes and deletion
- Allow squash merging only — disable merge commits and rebase merging

Leave "require approvals" at **0** while the team is one or two people.
Turning it on with no second reviewer means either nothing merges or everyone
learns to bypass protection. Set it to 1 the day a third developer joins.

## Architecture decisions

Significant decisions are recorded as ADRs in `docs/architecture/adr/`. Copy
`docs/architecture/adr/TEMPLATE.md`, take the next free number, and link it from
`docs/architecture/adr/README.md`.

Never edit an accepted ADR's decision in place. Write a new ADR that supersedes
it and mark the old one `Superseded by ADR-00NN`. The record of what was
believed at the time is the point.

## Releases

Tag `main` as `vMAJOR.MINOR.PATCH` when deploying to production. Tags are the
rollback targets — production always runs a tagged commit, never a branch tip.
