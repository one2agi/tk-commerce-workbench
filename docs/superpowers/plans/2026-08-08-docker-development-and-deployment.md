# Docker Development and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Web, Worker, and PostgreSQL fully in Docker with source hot reload, preserve the current database and assets, and produce portable production deployment artifacts and Chinese operating instructions.

**Architecture:** A multi-stage Node 22 Dockerfile provides development, Next.js production, and Worker production targets. The development Compose overlay bind-mounts source directories and reuses the existing external PostgreSQL volume; the production overlay runs immutable images without source mounts. A Node CLI owns safe preflight, backup, Compose lifecycle, image export, and readiness checks.

**Tech Stack:** Docker Desktop, Docker Compose v5, Node.js 22, pnpm 9.15.9, Next.js 16, TypeScript 5.9, PostgreSQL 16, Node test runner.

## Global Constraints

- Web, Worker, and PostgreSQL all run in Docker.
- Local Web is published only on `127.0.0.1:3000`.
- Reuse external volume `tk-commerce-workbench_postgres_data`; never silently create or delete it during the first local migration.
- Reuse `/home/morav/.local/share/tk-commerce-workbench/data/assets` and `/home/morav/.local/share/tk-commerce-workbench/.env` without copying secrets or assets into an image.
- A successful logical PostgreSQL backup and matching asset archive are required before the first Compose migration.
- TS, TSX, CSS, Worker source, and shared package source changes hot reload without rebuilding images.
- Dependency, lockfile, Dockerfile, and build-configuration changes require an explicit rebuild.
- Development and production Compose configurations remain separate.
- Production Web and Worker images use the same immutable Git commit tag.
- PostgreSQL is not published outside loopback locally and is not published at all in production by default.
- No Kubernetes, object-storage migration, hosted CI/CD, public database port, or business-flow change is included.

---

## File Map

- Create `.dockerignore`: exclude secrets, data, dependencies, build output, Git metadata, and local reports.
- Create `Dockerfile`: define `base`, `deps`, `dev`, `builder`, `web-runner`, and `worker-runner` targets.
- Modify `docker-compose.yml`: keep PostgreSQL compatibility and add stable volume naming and health behavior.
- Create `compose.dev.yml`: add migrate, Web, and Worker development services, source mounts, polling, and the external current database volume.
- Create `compose.prod.yml`: add migrate, Web, and Worker production services without source mounts.
- Modify `apps/web/scripts/run-next.mjs`: permit the explicit container-only bind host `0.0.0.0` while retaining loopback by default.
- Modify `apps/web/next.config.ts`: emit a Next.js standalone production artifact.
- Modify `apps/worker/package.json`: make `tsx` a production runtime dependency so `pnpm deploy --prod` produces a runnable Worker image.
- Create `scripts/docker/config.mjs`: pure path, environment, Compose-argument, and action helpers.
- Create `scripts/docker/backup.mjs`: create paired PostgreSQL and asset backups plus a manifest.
- Create `scripts/docker/cli.mjs`: preflight, lifecycle, readiness, logs, production build, export, and import commands.
- Create `scripts/docker-local.mjs`: minimal executable entrypoint that delegates to the CLI.
- Create `scripts/tests/docker-config.test.mjs`: unit tests for safe path and Compose invocation generation.
- Create `scripts/tests/docker-artifacts.test.mjs`: static contract tests for Dockerfile, ignore rules, and Compose safety.
- Create `scripts/tests/docker-backup.test.mjs`: unit tests for backup paths, manifest shape, and command failure behavior.
- Create `scripts/tests/run-next-container.test.mjs`: Web bind-host security tests.
- Modify `package.json`: add documented `docker:*` commands and a focused Docker test command.
- Create `docs/operations/docker-deployment.md`: Chinese local-development, VPS, backup, restore, upgrade, rollback, and troubleshooting guide.
- Modify `docs/operations/local-production.md`: link to the new all-Docker workflow while preserving the legacy host process workflow.

---

### Task 1: Container-safe Web binding and production output

**Files:**
- Create: `scripts/tests/run-next-container.test.mjs`
- Modify: `apps/web/scripts/run-next.mjs`
- Modify: `apps/web/next.config.ts`

**Interfaces:**
- Consumes: `process.env.TK_WEB_BIND_HOST`.
- Produces: `resolveBindHost(env: NodeJS.ProcessEnv): "127.0.0.1" | "0.0.0.0"` and Next standalone output.

- [ ] **Step 1: Write the failing bind-host test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildNextArgs, resolveBindHost } from "../../apps/web/scripts/run-next.mjs";

test("Web remains loopback-only unless container binding is explicit", () => {
  assert.equal(resolveBindHost({}), "127.0.0.1");
  assert.equal(resolveBindHost({ TK_WEB_BIND_HOST: "0.0.0.0" }), "0.0.0.0");
  assert.equal(resolveBindHost({ TK_WEB_BIND_HOST: "192.168.1.10" }), "127.0.0.1");
});

test("Next arguments carry the resolved container host", () => {
  assert.deepEqual(buildNextArgs("dev", { TK_WEB_BIND_HOST: "0.0.0.0" }), [
    "dev", "--webpack", "-H", "0.0.0.0"
  ]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/tests/run-next-container.test.mjs`

Expected: FAIL because `resolveBindHost` and `buildNextArgs` do not accept an environment argument.

- [ ] **Step 3: Implement the explicit container bind host**

```js
export function resolveBindHost(env = process.env) {
  return env.TK_WEB_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
}

export function buildNextArgs(mode, env = process.env) {
  if (mode !== "dev" && mode !== "start") throw new Error("Expected Next mode: dev or start");
  return [mode, ...(mode === "dev" ? ["--webpack"] : []), "-H", resolveBindHost(env)];
}
```

Add `output: "standalone"` to the exported `NextConfig`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --test scripts/tests/run-next-container.test.mjs && pnpm --filter @tk/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/tests/run-next-container.test.mjs apps/web/scripts/run-next.mjs apps/web/next.config.ts
git commit -m "feat(docker): support container web binding"
```

---

### Task 2: Multi-stage development and production images

**Files:**
- Create: `.dockerignore`
- Create: `Dockerfile`
- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `scripts/tests/docker-artifacts.test.mjs`

**Interfaces:**
- Consumes: pnpm workspace lockfile and Next standalone output.
- Produces: Docker targets `dev`, `web-runner`, and `worker-runner`.

- [ ] **Step 1: Write failing artifact contract tests**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Docker build excludes secrets and local business data", async () => {
  const ignore = await readFile(".dockerignore", "utf8");
  for (const entry of [".env", "data", "node_modules", ".next", ".git"]) {
    assert.match(ignore, new RegExp(`^${entry.replace(".", "\\\\.")}/?$`, "m"));
  }
});

test("Dockerfile exposes all required targets", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  for (const stage of ["dev", "builder", "web-runner", "worker-runner"]) {
    assert.match(dockerfile, new RegExp(` AS ${stage}\\\\b`));
  }
  assert.doesNotMatch(dockerfile, /COPY\\s+\\.env/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/tests/docker-artifacts.test.mjs`

Expected: FAIL because `.dockerignore` and `Dockerfile` do not exist.

- [ ] **Step 3: Add `.dockerignore` and Docker stages**

Use `node:22-bookworm-slim`, enable Corepack, pin pnpm through `packageManager`, install with `pnpm install --frozen-lockfile`, and define:

```dockerfile
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS dev
COPY . .

FROM dev AS builder
RUN pnpm --filter @tk/web build
RUN pnpm --filter @tk/worker deploy --prod /out/worker

FROM node:22-bookworm-slim AS web-runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
CMD ["node", "apps/web/server.js"]

FROM node:22-bookworm-slim AS worker-runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /out/worker ./
CMD ["node", "--import", "tsx", "src/cli.ts"]
```

If `apps/web/public` does not exist, create an empty tracked `apps/web/public/.gitkeep` or omit both the source mount and copy consistently.

- [ ] **Step 4: Move `tsx` into Worker production dependencies**

Run: `pnpm --filter @tk/worker add tsx@4.23.1`

Remove the duplicate `tsx` entry from `apps/worker/package.json` `devDependencies` if pnpm leaves both entries.

- [ ] **Step 5: Validate tests and build targets**

Run: `node --test scripts/tests/docker-artifacts.test.mjs`

Run: `docker build --target dev -t tk-commerce-workbench:dev .`

Run: `docker build --target web-runner -t tk-commerce-workbench-web:$(git rev-parse --short HEAD) .`

Run: `docker build --target worker-runner -t tk-commerce-workbench-worker:$(git rev-parse --short HEAD) .`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add .dockerignore Dockerfile apps/worker/package.json pnpm-lock.yaml scripts/tests/docker-artifacts.test.mjs apps/web/public/.gitkeep
git commit -m "feat(docker): add development and production images"
```

Omit `apps/web/public/.gitkeep` from `git add` when the directory already exists or the Dockerfile omits the copy.

---

### Task 3: Development and production Compose definitions

**Files:**
- Modify: `docker-compose.yml`
- Create: `compose.dev.yml`
- Create: `compose.prod.yml`
- Extend: `scripts/tests/docker-artifacts.test.mjs`

**Interfaces:**
- Consumes: `TK_WORKBENCH_ENV_FILE`, `TK_WORKBENCH_ASSET_DIR`, `TK_IMAGE_TAG`, and `TK_WEB_PORT` supplied by the CLI.
- Produces: validated Compose service graph `postgres -> migrate -> {web, worker}`.

- [ ] **Step 1: Add failing Compose safety assertions**

```js
test("development Compose protects the current database and mounts current assets", async () => {
  const compose = await readFile("compose.dev.yml", "utf8");
  assert.match(compose, /external:\s*true/);
  assert.match(compose, /TK_WORKBENCH_ASSET_DIR/);
  assert.match(compose, /127\.0\.0\.1:\$\{TK_WEB_PORT:-3000\}:3000/);
  assert.match(compose, /WATCHPACK_POLLING:\s*"true"/);
  assert.match(compose, /CHOKIDAR_USEPOLLING:\s*"true"/);
});

test("production Compose has no source mounts", async () => {
  const compose = await readFile("compose.prod.yml", "utf8");
  assert.doesNotMatch(compose, /\.\/apps\/.*\/src/);
  assert.match(compose, /TK_IMAGE_TAG/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/tests/docker-artifacts.test.mjs`

Expected: FAIL because the Compose overlays do not exist.

- [ ] **Step 3: Implement the Compose service graph**

Keep `docker-compose.yml` compatible with `docker compose up postgres`, give `postgres_data` the stable name `tk-commerce-workbench_postgres_data`, retain loopback port `5432` for legacy host tooling, and remove the hard-coded `container_name` so isolated production smoke projects can coexist. In `compose.prod.yml`, use Compose `!reset []` on PostgreSQL `ports` so the production merge publishes no database port.

In `compose.dev.yml`:

```yaml
services:
  migrate:
    image: tk-commerce-workbench:dev
    command: ["pnpm", "db:migrate"]
    env_file: ["${TK_WORKBENCH_ENV_FILE}"]
    environment: &app_environment
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/tk_workbench
      TEST_DATABASE_URL: postgresql://postgres:postgres@postgres:5432/tk_workbench_test
      ASSET_ROOT: /app/data/assets
    depends_on:
      postgres: { condition: service_healthy }
  web:
    image: tk-commerce-workbench:dev
    command: ["pnpm", "--filter", "@tk/web", "dev"]
    ports: ["127.0.0.1:${TK_WEB_PORT:-3000}:3000"]
    environment:
      <<: *app_environment
      TK_WEB_BIND_HOST: 0.0.0.0
      WATCHPACK_POLLING: "true"
      CHOKIDAR_USEPOLLING: "true"
    depends_on:
      migrate: { condition: service_completed_successfully }
  worker:
    image: tk-commerce-workbench:dev
    command: ["pnpm", "--filter", "@tk/worker", "dev"]
    environment:
      <<: *app_environment
      CHOKIDAR_USEPOLLING: "true"
    depends_on:
      migrate: { condition: service_completed_successfully }
volumes:
  postgres_data:
    external: true
    name: tk-commerce-workbench_postgres_data
```

Add read/write asset mounts to migrate, Web, and Worker, source-directory mounts to Web and Worker, and a named `.next` cache volume for Web. Ensure every source mount targets a path already present in the image so workspace package resolution remains intact.

In `compose.prod.yml`, use `tk-commerce-workbench-web:${TK_IMAGE_TAG}` and `tk-commerce-workbench-worker:${TK_IMAGE_TAG}`, no source mounts, no PostgreSQL host port, and the same migrate-before-app dependency rule.

- [ ] **Step 4: Validate merged Compose configurations**

Run with non-secret path variables:

```bash
TK_WORKBENCH_ENV_FILE=/home/morav/.local/share/tk-commerce-workbench/.env \
TK_WORKBENCH_ASSET_DIR=/home/morav/.local/share/tk-commerce-workbench/data/assets \
docker compose -p tk-commerce-workbench -f docker-compose.yml -f compose.dev.yml config --quiet
```

Run:

```bash
TK_WORKBENCH_ENV_FILE=/home/morav/.local/share/tk-commerce-workbench/.env \
TK_WORKBENCH_ASSET_DIR=/home/morav/.local/share/tk-commerce-workbench/data/assets \
TK_IMAGE_TAG=test \
docker compose -p tk-commerce-workbench -f docker-compose.yml -f compose.prod.yml config --quiet
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml compose.dev.yml compose.prod.yml scripts/tests/docker-artifacts.test.mjs
git commit -m "feat(docker): add development and production compose"
```

---

### Task 4: Safe Docker configuration and lifecycle CLI

**Files:**
- Create: `scripts/docker/config.mjs`
- Create: `scripts/docker/cli.mjs`
- Create: `scripts/docker-local.mjs`
- Create: `scripts/tests/docker-config.test.mjs`

**Interfaces:**
- Produces: `resolveDockerPaths(options)`, `buildComposeArgs(input)`, `runDockerCli(argv, dependencies)`.
- Consumes: filesystem, port, Docker, and HTTP dependencies through injected functions in tests.

- [ ] **Step 1: Write failing pure-helper tests**

```js
test("resolveDockerPaths uses the existing storage layout", () => {
  assert.deepEqual(resolveDockerPaths({ homeDir: "/home/test", env: {} }), {
    storageDir: "/home/test/.local/share/tk-commerce-workbench",
    envFile: "/home/test/.local/share/tk-commerce-workbench/.env",
    assetDir: "/home/test/.local/share/tk-commerce-workbench/data/assets",
    backupDir: "/home/test/.local/share/tk-commerce-workbench/data/backups"
  });
});

test("development invocation always uses the protected project and overlay", () => {
  assert.deepEqual(buildComposeArgs({ mode: "dev", operation: ["up", "-d"] }), [
    "compose", "-p", "tk-commerce-workbench", "-f", "docker-compose.yml",
    "-f", "compose.dev.yml", "up", "-d"
  ]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/tests/docker-config.test.mjs`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement pure configuration helpers**

```js
export function resolveDockerPaths({ env = process.env, homeDir = homedir() } = {}) {
  const storageDir = resolve(env.TK_WORKBENCH_STORAGE_DIR || join(homeDir, ".local", "share", "tk-commerce-workbench"));
  return {
    storageDir,
    envFile: join(storageDir, ".env"),
    assetDir: join(storageDir, "data", "assets"),
    backupDir: join(storageDir, "data", "backups")
  };
}

export function buildComposeArgs({ mode, operation }) {
  const overlay = mode === "dev" ? "compose.dev.yml" : "compose.prod.yml";
  return ["compose", "-p", "tk-commerce-workbench", "-f", "docker-compose.yml", "-f", overlay, ...operation];
}
```

- [ ] **Step 4: Implement CLI actions and safe preflight**

Support exact actions:

- `dev:up`: verify Docker, paths, external volume, and port; then run `up -d --build --wait`.
- `dev:down`: run `down --remove-orphans` without `-v`.
- `dev:status`: run `ps` and request `/api/runtime-health`.
- `dev:logs [service]`: follow logs for Web, Worker, PostgreSQL, or all services.
- `prod:build`: build immutable Web and Worker images using current short SHA.
- `prod:up`: require `TK_IMAGE_TAG`, validate production config, then run `up -d --wait`.
- `prod:down`: run production `down --remove-orphans` without `-v`.
- `image:export /tmp/tk-commerce-workbench-images.tar`: save Web and Worker images for one tag.
- `image:import /tmp/tk-commerce-workbench-images.tar`: load a previously exported archive.

The CLI environment must include only path selectors and image tags in addition to the caller environment:

```js
{
  ...process.env,
  TK_WORKBENCH_ENV_FILE: paths.envFile,
  TK_WORKBENCH_ASSET_DIR: paths.assetDir,
  TK_IMAGE_TAG: imageTag
}
```

Preflight errors must name the missing path, missing volume, unavailable Docker daemon, or occupied port without printing `.env` contents.

- [ ] **Step 5: Run unit tests and syntax checks**

Run: `node --test scripts/tests/docker-config.test.mjs`

Run: `node --check scripts/docker/config.mjs && node --check scripts/docker/cli.mjs && node --check scripts/docker-local.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/docker/config.mjs scripts/docker/cli.mjs scripts/docker-local.mjs scripts/tests/docker-config.test.mjs
git commit -m "feat(docker): add safe lifecycle commands"
```

---

### Task 5: Paired database and asset backup

**Files:**
- Create: `scripts/docker/backup.mjs`
- Create: `scripts/tests/docker-backup.test.mjs`
- Modify: `scripts/docker/cli.mjs`

**Interfaces:**
- Produces: `createBackupPaths({ backupRoot, timestamp })` and `createPairedBackup(input)` returning `{ backupDir, databaseFile, assetsFile, manifestFile }`.
- Consumes: the PostgreSQL service container ID returned by `docker compose -p tk-commerce-workbench ps -q postgres` and the resolved asset directory.

- [ ] **Step 1: Write failing backup-path and failure-order tests**

```js
test("backup files share one timestamped directory", () => {
  assert.deepEqual(createBackupPaths({ backupRoot: "/backup", timestamp: "20260808T120000Z" }), {
    backupDir: "/backup/20260808T120000Z",
    databaseFile: "/backup/20260808T120000Z/postgres.dump",
    assetsFile: "/backup/20260808T120000Z/assets.tar.gz",
    manifestFile: "/backup/20260808T120000Z/manifest.json"
  });
});

test("failed pg_dump prevents asset archive and manifest creation", async () => {
  const calls = [];
  await assert.rejects(() => createPairedBackup({
    paths,
    runPgDump: async () => { calls.push("db"); throw new Error("dump failed"); },
    runAssetArchive: async () => calls.push("assets"),
    writeManifest: async () => calls.push("manifest")
  }), /dump failed/);
  assert.deepEqual(calls, ["db"]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/tests/docker-backup.test.mjs`

Expected: FAIL because the backup module does not exist.

- [ ] **Step 3: Implement paired backup**

Create the timestamp directory with mode `0700`, resolve the current PostgreSQL service container ID, and stream this command into `postgres.dump`:

```bash
docker exec "$postgres_container_id" pg_dump -U postgres -d tk_workbench -Fc
```

After the database dump succeeds, create `assets.tar.gz` by invoking `tar` with the exact argument array `["-czf", paths.assetsFile, "-C", assetDir, "."]`, so paths are not interpreted by a shell.

Write `manifest.json` only after both commands succeed. Include UTC timestamp, database volume name, asset source path, Git commit, dump byte size, asset archive byte size, and SHA-256 digests. Never include environment values or connection strings.

- [ ] **Step 4: Add CLI commands and first-migration guard**

Add `backup` to create a paired backup. `dev:up` must check for a successful Docker migration backup marker under the backup directory and automatically create the first backup when the marker is absent. Write the marker only after backup and the first successful readiness check.

- [ ] **Step 5: Run tests**

Run: `node --test scripts/tests/docker-backup.test.mjs scripts/tests/docker-config.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/docker/backup.mjs scripts/docker/cli.mjs scripts/tests/docker-backup.test.mjs scripts/tests/docker-config.test.mjs
git commit -m "feat(docker): protect data with paired backups"
```

---

### Task 6: Commands and deployment documentation

**Files:**
- Modify: `package.json`
- Create: `docs/operations/docker-deployment.md`
- Modify: `docs/operations/local-production.md`
- Extend: `scripts/tests/docker-artifacts.test.mjs`

**Interfaces:**
- Produces user commands `docker:dev:up`, `docker:dev:down`, `docker:status`, `docker:logs`, `docker:backup`, `docker:prod:build`, `docker:prod:up`, and `docker:prod:down`.

- [ ] **Step 1: Add failing package-script and documentation tests**

```js
test("package scripts expose the supported Docker lifecycle", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  for (const name of [
    "docker:dev:up", "docker:dev:down", "docker:status", "docker:logs",
    "docker:backup", "docker:prod:build", "docker:prod:up", "docker:prod:down"
  ]) assert.equal(typeof pkg.scripts[name], "string");
});

test("deployment guide covers local and remote recovery paths", async () => {
  const guide = await readFile("docs/operations/docker-deployment.md", "utf8");
  for (const heading of ["本地热重载", "沿用现有数据", "VPS", "备份", "恢复", "回滚", "排障"]) {
    assert.match(guide, new RegExp(heading));
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/tests/docker-artifacts.test.mjs`

Expected: FAIL because scripts and the deployment guide are absent.

- [ ] **Step 3: Add package scripts**

```json
{
  "docker:dev:up": "node scripts/docker-local.mjs dev:up",
  "docker:dev:down": "node scripts/docker-local.mjs dev:down",
  "docker:status": "node scripts/docker-local.mjs dev:status",
  "docker:logs": "node scripts/docker-local.mjs dev:logs",
  "docker:backup": "node scripts/docker-local.mjs backup",
  "docker:prod:build": "node scripts/docker-local.mjs prod:build",
  "docker:prod:up": "node scripts/docker-local.mjs prod:up",
  "docker:prod:down": "node scripts/docker-local.mjs prod:down",
  "test:docker": "node --test scripts/tests/docker-*.test.mjs scripts/tests/run-next-container.test.mjs"
}
```

- [ ] **Step 4: Write the Chinese deployment guide**

Document exact commands for:

- First local migration with automatic paired backup.
- Development build, up, status, logs, source hot reload, dependency rebuild, and down.
- Production image build and fixed-tag start.
- Registry deployment and offline `docker save`/`docker load` deployment.
- Target `.env`, asset directory, PostgreSQL volume, restore, upgrade, and rollback.
- Port conflict, Docker daemon, volume, permissions, database, health, and polling troubleshooting.

State explicitly that database and asset backups must be restored as one pair.

- [ ] **Step 5: Link the legacy operations guide**

Add a short section to `docs/operations/local-production.md` explaining that it remains the host-process workflow and linking to `docker-deployment.md` for the all-Docker workflow.

- [ ] **Step 6: Run tests and commit**

Run: `node --test scripts/tests/docker-artifacts.test.mjs`

Expected: PASS.

```bash
git add package.json docs/operations/docker-deployment.md docs/operations/local-production.md scripts/tests/docker-artifacts.test.mjs
git commit -m "docs(docker): add local and VPS operations guide"
```

---

### Task 7: Static verification and production image gate

**Files:**
- Modify only files found faulty by the commands below, keeping fixes within Docker scope.

**Interfaces:**
- Consumes all artifacts from Tasks 1-6.
- Produces buildable, type-safe, Compose-valid development and production configurations.

- [ ] **Step 1: Run Docker-focused tests**

Run: `pnpm test:docker`

Expected: all Node tests PASS.

- [ ] **Step 2: Run typecheck and focused existing tests**

Run: `pnpm --filter @tk/web typecheck && pnpm --filter @tk/worker typecheck && pnpm --filter @tk/config test`

Expected: PASS.

- [ ] **Step 3: Validate Compose rendering**

Run both development and production `docker compose ... config --quiet` commands from Task 3.

Expected: exit 0 and no unresolved variable warnings.

- [ ] **Step 4: Build all Docker targets**

Run:

```bash
pnpm docker:prod:build
docker build --target dev -t tk-commerce-workbench:dev .
```

Expected: Web and Worker production images plus the development image build successfully.

- [ ] **Step 5: Inspect images for forbidden files**

Run container-side checks that `/app/.env`, `/app/data`, and `/app/.git` do not exist in Web and Worker production images.

Expected: all forbidden paths are absent.

- [ ] **Step 6: Commit verification fixes if necessary**

```bash
git add .dockerignore Dockerfile docker-compose.yml compose.dev.yml compose.prod.yml \
  apps/web/next.config.ts apps/web/scripts/run-next.mjs apps/worker/package.json \
  pnpm-lock.yaml scripts/docker scripts/docker-local.mjs scripts/tests
git commit -m "fix(docker): satisfy production build gate"
```

Skip the commit when verification requires no changes.

---

### Task 8: Existing-data migration and hot-reload acceptance

**Files:**
- No source edits expected; evidence is command output and backup artifacts outside Git.

**Interfaces:**
- Consumes current volume `tk-commerce-workbench_postgres_data`, current assets, and current storage `.env`.
- Produces a running development Compose stack with a recorded paired backup marker.

- [ ] **Step 1: Capture pre-migration evidence**

Record the PostgreSQL volume inspect result, database table list and representative row counts, asset file count and total bytes, and current container IDs. Do not print secret values.

- [ ] **Step 2: Run the paired backup**

Run: `pnpm docker:backup`

Expected: a timestamped directory contains `postgres.dump`, `assets.tar.gz`, and `manifest.json`, each non-empty and digest-verified.

- [ ] **Step 3: Start the all-Docker development stack**

Run: `pnpm docker:dev:up`

Expected: PostgreSQL healthy, migration exits 0, Web healthy, Worker running, and the command reports `http://127.0.0.1:3000`.

- [ ] **Step 4: Verify HTTP and container ownership**

Run: `pnpm docker:status`

Run: `curl --noproxy '*' --fail --max-time 15 http://127.0.0.1:3000/api/runtime-health`

Expected: HTTP 200 and Web, Worker, and PostgreSQL appear in the `tk-commerce-workbench` Compose project.

- [ ] **Step 5: Verify Web hot reload without container replacement**

Capture the Web container ID, `touch apps/web/src/app/globals.css`, wait for a successful Web recompilation log entry, and confirm the container ID is unchanged.

- [ ] **Step 6: Verify Worker/shared-package hot reload without container replacement**

Capture the Worker container ID, `touch apps/worker/src/main.ts`, wait for the `tsx watch` restart log, and confirm the container ID is unchanged. Repeat with `touch packages/config/src/index.ts` to prove shared-package watching.

- [ ] **Step 7: Verify persistence across recreation**

Capture the same representative row counts and asset metadata, run `pnpm docker:dev:down`, then `pnpm docker:dev:up`, and confirm the values are unchanged.

- [ ] **Step 8: Leave the requested local state running**

Run: `pnpm docker:status`

Expected: development Web, Worker, and PostgreSQL are healthy, using the preserved data and assets.

---

### Task 9: Portable production deployment smoke test

**Files:**
- Modify documentation or Docker artifacts only if the smoke test finds a defect.

**Interfaces:**
- Consumes immutable Web and Worker images from Task 7.
- Produces a verified online/offline deployment path for a VPS or another Docker computer.

- [ ] **Step 1: Export immutable images**

Run: `node scripts/docker-local.mjs image:export /tmp/tk-commerce-workbench-images.tar`

Expected: archive exists and contains both Web and Worker images with the same Git tag.

- [ ] **Step 2: Verify image import metadata**

Run `docker image inspect` for both tagged images and confirm architecture, creation time, and tag. Use `docker load -i` on the archive to verify it is self-contained.

- [ ] **Step 3: Render production Compose for a target host**

Use an isolated temporary environment file, asset directory, Compose project name, Web port `3100`, and disposable PostgreSQL volume. Do not use the current business volume for this production smoke test.

- [ ] **Step 4: Start and verify the isolated production stack**

Run production Compose and verify `http://127.0.0.1:3100/api/runtime-health`, Web and Worker image tags, no source mounts, and no published PostgreSQL port.

- [ ] **Step 5: Stop and remove only disposable smoke resources**

Resolve the exact temporary project name and disposable volume before removal. Remove only those resources; do not remove `tk-commerce-workbench_postgres_data` or the current assets.

- [ ] **Step 6: Run final repository checks**

Run: `git diff --check && git status --short --branch`

Expected: no uncommitted Docker implementation changes and no unrelated original-worktree modifications.

- [ ] **Step 7: Commit smoke-test fixes if necessary**

```bash
git add .dockerignore Dockerfile docker-compose.yml compose.dev.yml compose.prod.yml \
  package.json pnpm-lock.yaml apps/web/next.config.ts apps/web/scripts/run-next.mjs \
  apps/worker/package.json scripts/docker scripts/docker-local.mjs scripts/tests \
  docs/operations/docker-deployment.md docs/operations/local-production.md
git commit -m "fix(docker): complete portable deployment smoke test"
```

Skip the commit when the smoke test requires no source changes.
