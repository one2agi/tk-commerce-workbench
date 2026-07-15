# Agent Lane Ownership

> Frozen by **Plan Task 6 Gate G1** on 2026-07-15. Per-lane edits crossing into another lane's
> owned paths must be returned to the responsible agent — the Coordinator does not invent
> cross-lane resolutions.

## Branches

| Lane | Branch | Worktree (relative to repo root) |
| --- | --- | --- |
| Edge | `agent/w{1,2,3}-edge` | `.worktrees/w{1,2,3}-edge` |
| Core | `agent/w{1,2,3}-core` | `.worktrees/w{1,2,3}-core` |
| Web  | `agent/w{1,2,3}-web`  | `.worktrees/w{1,2,3}-web`  |
| Coordinator | `integration/tk-mvp` | (main checkout) |

## Owned path matrix

| Path root | Edge | Core | Web | Coordinator |
| --- | --- | --- | --- | --- |
| `apps/extension/**` | ✓ | | | |
| `apps/web/**` | | | ✓ | |
| `apps/worker/**` | | ✓ | | entry only via merge |
| `packages/adapters/**` | ✓ | | | |
| `packages/domain/**` | | ✓ | | |
| `packages/db/**` | | ✓ | | |
| `packages/contracts/**` | | | | ✓ (frozen) |
| `packages/config/**` | | | | ✓ |
| `tests/fixtures/external/**` | ✓ | | | |
| `tests/fixtures/domain/**` | | ✓ | | |
| `e2e/**` | | | | ✓ |
| `docs/**` | | | | ✓ |
| `scripts/**` | | | | ✓ |
| `.github/**` | | | | ✓ |
| Root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `docker-compose.yml`, `.env.example`, `.gitignore`, `.node-version` | | | | ✓ |

## Dependency graph (test gate ordering)

```
Task 1 Repository Foundation                          (Coordinator)
        ↓
Task 2 Contracts v1 + Config v1                      (Coordinator)
        ↓ G0
 ┌──────────────┬──────────────┬──────────────┐
 │ Task 3 Edge  │ Task 4 Core  │ Task 5 Web   │  Wave 1
 └──────────────┴──────────────┴──────────────┘
        ↓ G1 merge order → Core → Edge → Web
 ┌──────────────┬──────────────┬──────────────┐
 │ Task 7 Edge  │ Task 8 Core  │ Task 9 Web   │  Wave 2
 └──────────────┴──────────────┴──────────────┘
        ↓ G2 merge order → Core → Edge → Web
 ┌──────────────┬──────────────┬──────────────┐
 │ Task 11 Edge │ Task 12 Core │ Task 13 Web  │  Wave 3
 └──────────────┴──────────────┴──────────────┘
        ↓ G3 merge order → Core → Edge → Web
Task 15 Hardening + Release Acceptance                (Coordinator)
```

## New dependency requests

Whenever an Agent needs a new runtime dependency, **the Agent reports it**, the Coordinator
runs `pnpm add` once and regenerates the lockfile at the gate merge. The Agent never edits
`pnpm-lock.yaml` directly.

| Wave | Lane | Package (devDep/runtime) | Purpose |
| --- | --- | --- | --- |
| W1 | Core | `@electric-sql/pglite` (devDep, `@tk/db`) | Test-only PostgreSQL-16-compatible backend for WSL2 fallback |
| W1 | Core | `@electric-sql/pglite-socket` (devDep, `@tk/db`) | Loopback TCP bridge for PGlite → existing `pg` repositories |

## Conflict policy

- Cross-lane file edits discovered at any gate cause the offending merge to be aborted and
  the diff returned to the originating lane's agent. The Coordinator does not invent a
  cross-lane resolution.
- Lockfile regeneration is the only place where lane-specific dependency requests are
  materialised. After merge of a wave, run a single `pnpm install` at the integration
  worktree.
