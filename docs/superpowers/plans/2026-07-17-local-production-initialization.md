# Local Production Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize a safe, persistent local production instance of TK Commerce Workbench with PostgreSQL, Web, Worker, extension assets, and mock-only external adapters.

**Architecture:** A Node.js bootstrap utility creates the ignored `.env` and persistent `data/` directories without printing secrets. A separate Node.js runtime manager owns detached Web/Worker processes through validated PID metadata and bounded stop logic. PostgreSQL remains managed by the existing loopback-only Docker Compose service.

**Tech Stack:** Node.js 22, pnpm 9.15.9, Docker Compose, PostgreSQL 16, Next.js 16, Node `child_process`, `node:test`.

## Global Constraints

- `EXTERNAL_ADAPTER_MODE=mock` throughout this initialization; no live Miaoshou, Canvas, LLM, or exchange-rate calls.
- Secrets are written only to Git-ignored `.env`; never print values, authorization headers, or credential file contents.
- Preserve the existing untracked `CLAUDE.md`.
- Web and PostgreSQL bind only to loopback; keep `ALLOW_LAN=false`.
- Persist product media under `data/assets` and runtime metadata under `data/runtime`.
- Do not delete the PostgreSQL volume or `data/assets` during rollback.

---

### Task 1: Idempotent Secret-Safe Configuration Bootstrap

**Files:**
- Create: `scripts/local-production-config.mjs`
- Create: `scripts/tests/local-production-config.test.mjs`

**Interfaces:**
- Consumes: `TKskill/env.txt` containing labeled `APP ID:` and `APP Secret:` values.
- Produces: `parseMiaoshouCredentials(text): { appKey: string; appSecret: string }` and `initializeLocalProduction({ repoRoot, credentialFile, outputFile }): { created: true; assetRoot: string; runtimeRoot: string }`.

- [ ] **Step 1: Write failing parser and bootstrap tests**

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeLocalProduction, parseMiaoshouCredentials } from "../local-production-config.mjs";

test("parses labeled Miaoshou credentials across CRLF or whitespace", () => {
  assert.deepEqual(parseMiaoshouCredentials("APP ID: demo-id\r\nAPP Secret: demo-secret"), {
    appKey: "demo-id",
    appSecret: "demo-secret"
  });
});

test("creates an ignored mock-only env without exposing secret values", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-local-production-"));
  const credentialFile = join(repoRoot, "credentials.txt");
  await writeFile(credentialFile, "APP ID: demo-id\nAPP Secret: demo-secret");
  await initializeLocalProduction({ repoRoot, credentialFile, outputFile: join(repoRoot, ".env") });
  const env = await readFile(join(repoRoot, ".env"), "utf8");
  assert.match(env, /^EXTERNAL_ADAPTER_MODE=mock$/m);
  assert.match(env, /^ALLOW_LAN=false$/m);
  assert.match(env, /^MIAOSHOU_APP_KEY=demo-id$/m);
  assert.match(env, /^EXTENSION_TOKEN=[A-Za-z0-9_-]{43}$/m);
  assert.equal((await stat(join(repoRoot, "data/assets"))).isDirectory(), true);
});

test("refuses to overwrite an existing env", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-local-production-existing-"));
  const outputFile = join(repoRoot, ".env");
  const credentialFile = join(repoRoot, "credentials.txt");
  await writeFile(outputFile, "KEEP=1\n");
  await writeFile(credentialFile, "APP ID: demo-id\nAPP Secret: demo-secret");
  await assert.rejects(() => initializeLocalProduction({ repoRoot, credentialFile, outputFile }), /already exists/);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/tests/local-production-config.test.mjs`

Expected: FAIL because `scripts/local-production-config.mjs` does not exist.

- [ ] **Step 3: Implement the minimal bootstrap utility**

```js
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseMiaoshouCredentials(text) {
  const normalized = text.replace(/\r/g, "\n");
  const appKey = normalized.match(/APP ID:\s*([^\s]+)/i)?.[1]?.trim();
  const appSecret = normalized.match(/APP Secret:\s*([^\s]+)/i)?.[1]?.trim();
  if (!appKey || !appSecret) throw new Error("Miaoshou APP ID and APP Secret are required");
  return { appKey, appSecret };
}

export async function initializeLocalProduction({ repoRoot, credentialFile, outputFile }) {
  const credentials = parseMiaoshouCredentials(await readFile(credentialFile, "utf8"));
  const assetRoot = join(repoRoot, "data/assets");
  const runtimeRoot = join(repoRoot, "data/runtime");
  await mkdir(assetRoot, { recursive: true, mode: 0o700 });
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const lines = [
    "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench",
    "TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
    "LOCAL_OPERATOR_ID=local-operator",
    `EXTENSION_TOKEN=${randomBytes(32).toString("base64url")}`,
    "ALLOW_LAN=false",
    "EXTERNAL_ADAPTER_MODE=mock",
    `MIAOSHOU_APP_KEY=${credentials.appKey}`,
    `MIAOSHOU_APP_SECRET=${credentials.appSecret}`,
    "CANVAS_BASE_URL=https://canvas-n8n.ai2hook.com",
    "CANVAS_API_KEY=",
    "LLM_BASE_URL=",
    "LLM_API_KEY=",
    "LLM_MODEL=",
    "EXCHANGE_RATE_BASE_URL=",
    `ASSET_ROOT=${assetRoot}`,
    "WORKER_CONCURRENCY=2",
    "WORKER_LEASE_MS=60000",
    "MAX_CANVAS_RUNS_PER_DAY=50"
  ];
  await writeFile(outputFile, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  return { created: true, assetRoot, runtimeRoot };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await initializeLocalProduction({
    repoRoot,
    credentialFile: process.argv[2] ?? resolve(repoRoot, "../TKskill/env.txt"),
    outputFile: join(repoRoot, ".env")
  });
  process.stdout.write("Local production configuration initialized in mock mode.\n");
}
```

Implementation must also validate values do not contain newline, NUL, or `=` before rendering.

- [ ] **Step 4: Run GREEN and security checks**

Run:

```bash
node --test scripts/tests/local-production-config.test.mjs
git check-ignore -q .env data/assets data/runtime
```

Expected: all tests PASS and all local artifacts are ignored.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/local-production-config.mjs scripts/tests/local-production-config.test.mjs
git commit -m "feat(ops): add secret-safe local production bootstrap"
```

---

### Task 2: Bounded Local Runtime Manager

**Files:**
- Create: `scripts/local-production-runtime.mjs`
- Create: `scripts/tests/local-production-runtime.test.mjs`

**Interfaces:**
- Consumes: ignored `.env`, built `apps/web/.next`, PostgreSQL at `127.0.0.1:5432`.
- Produces commands `start`, `stop`, and `status`; PID metadata at `data/runtime/processes.json`; redacted `web.log` and `worker.log`.

- [ ] **Step 1: Write failing lifecycle tests**

Use `node:test` with temporary dummy Node child processes. Assert that `readEnvFile()` parses without shell evaluation, `writeProcessMetadata()` uses exclusive creation, stale PIDs are rejected, and `stopManagedProcess()` refuses a PID whose `/proc/<pid>/cmdline` does not contain the recorded marker.

```js
test("env parser treats values as data rather than shell", () => {
  assert.deepEqual(readEnvFile("SAFE=$(touch /tmp/never-run)\nMODE=mock\n"), {
    SAFE: "$(touch /tmp/never-run)",
    MODE: "mock"
  });
});
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `node --test scripts/tests/local-production-runtime.test.mjs`

Expected: FAIL because the runtime manager does not exist.

- [ ] **Step 3: Implement start/status/stop**

Implement the parser and PID guard exactly as follows, then compose `startLocalProduction`, `statusLocalProduction`, and `stopLocalProduction` from these guards:

```js
import { readFile } from "node:fs/promises";

export function readEnvFile(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("\0")) throw new Error("env contains NUL");
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("invalid env assignment");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate env key: ${key}`);
    result[key] = value;
  }
  return result;
}

export async function processIsManaged(pid, marker) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.split("\0").join(" ").includes(marker);
  } catch {
    return false;
  }
}

export async function stopManagedProcess({ pid, marker, waitMs = 10_000 }) {
  if (!(await processIsManaged(pid, marker))) throw new Error(`refusing unmanaged PID ${pid}`);
  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await processIsManaged(pid, marker))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill(-pid, "SIGKILL");
  if (await processIsManaged(pid, marker)) throw new Error(`process group ${pid} survived SIGKILL`);
}
```

`startLocalProduction({ repoRoot })` must parse `.env`, assert `EXTERNAL_ADAPTER_MODE === "mock"` and `ALLOW_LAN === "false"`, open append-only log descriptors, spawn each command with `detached: true`, write `{ version: 1, web: { pid, marker }, worker: { pid, marker } }` using `flag: "wx"`, and call `statusLocalProduction` before returning. `statusLocalProduction` must validate both `/proc` markers, fetch the Web URL, and query PostgreSQL for the Worker `application_name`. `stopLocalProduction` must call `stopManagedProcess` for both records and remove only `processes.json` after both groups stop.

Start commands are exact:

```text
pnpm --filter @tk/web start
env PGAPPNAME=tk-workbench-local-worker pnpm --filter @tk/worker start
```

The manager must require `EXTERNAL_ADAPTER_MODE=mock`, `ALLOW_LAN=false`, an existing `.env`, a healthy production build, and no existing live PID metadata. It must wait for `http://127.0.0.1:3000/` to return 2xx and for `pg_stat_activity.application_name = 'tk-workbench-local-worker'` before reporting success. Logs must be scanned for `Authorization`, `APP Secret`, or configured secret values; any match stops both processes and returns nonzero.

- [ ] **Step 4: Run GREEN and bounded cleanup tests**

Run:

```bash
node --test scripts/tests/local-production-runtime.test.mjs
node --check scripts/local-production-runtime.mjs
```

Expected: all tests PASS and no dummy child remains.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/local-production-runtime.mjs scripts/tests/local-production-runtime.test.mjs
git commit -m "feat(ops): manage local production processes safely"
```

---

### Task 3: Initialize and Start the Local Production Instance

**Files:**
- Create ignored: `.env`
- Create ignored: `data/assets/`
- Create ignored: `data/runtime/`

**Interfaces:**
- Consumes: Task 1 bootstrap utility and Task 2 runtime manager.
- Produces: healthy local Web/Worker/PostgreSQL and extension build at `apps/extension/dist`.

- [ ] **Step 1: Create the ignored production configuration**

Run: `node scripts/local-production-config.mjs ../TKskill/env.txt`

Expected output: `Local production configuration initialized in mock mode.` No secret values appear.

- [ ] **Step 2: Export the generated environment without shell evaluation**

Use a Node child-process wrapper from `scripts/local-production-runtime.mjs`; do not `source .env`. Start PostgreSQL first:

```bash
docker compose up -d --wait postgres
```

Expected: `tk-workbench-postgres` is healthy and publishes only `127.0.0.1:5432`.

- [ ] **Step 3: Migrate and build under the parsed environment**

Add an `exec` subcommand to the runtime manager that loads `.env` and runs a fixed allowlist of repository commands. Run:

```bash
node scripts/local-production-runtime.mjs exec db:migrate
node scripts/local-production-runtime.mjs exec build
```

Expected: migration and all workspace builds exit 0; `apps/web/.next/BUILD_ID` and `apps/extension/dist/manifest.json` exist.

- [ ] **Step 4: Start and verify Web/Worker**

Run:

```bash
node scripts/local-production-runtime.mjs start
node scripts/local-production-runtime.mjs status
```

Expected: Web HTTP 200, Worker PostgreSQL session present, both process markers valid, mode reported as `mock`.

- [ ] **Step 5: Verify no tracked secret or live mode**

Run:

```bash
git status --short
git check-ignore -v .env data/assets data/runtime
node -e 'fetch("http://127.0.0.1:3000/settings").then(r => { if (!r.ok) process.exit(1) })'
```

Expected: only the pre-existing untracked `CLAUDE.md` remains; `.env` and `data/` are ignored; settings endpoint responds successfully. Do not print `.env`.

---

### Task 4: Operations Handoff

**Files:**
- Create: `docs/operations/local-production.md`
- Modify: `docs/development/local-setup.md`

**Interfaces:**
- Consumes: verified runtime commands from Tasks 1–3.
- Produces: operator commands for status, stop, restart, extension loading, backup, and later live canary preparation.

- [ ] **Step 1: Write the operations guide**

Document these exact commands:

```bash
node scripts/local-production-runtime.mjs status
node scripts/local-production-runtime.mjs stop
node scripts/local-production-runtime.mjs start
docker compose ps postgres
```

State that the extension is loaded from the absolute `apps/extension/dist` path, PostgreSQL and `data/assets` must be backed up together, and switching `EXTERNAL_ADAPTER_MODE=live` is explicitly outside this initialization.

- [ ] **Step 2: Link the guide from local setup**

Add a “本地生产” section to `docs/development/local-setup.md` linking `../operations/local-production.md` and retaining the existing fresh-install G4 instructions.

- [ ] **Step 3: Verify documentation and final runtime state**

Run:

```bash
git diff --check
node --test scripts/tests/local-production-config.test.mjs scripts/tests/local-production-runtime.test.mjs
node scripts/local-production-runtime.mjs status
```

Expected: diff check and tests pass; runtime status is healthy and mock-only.

- [ ] **Step 4: Commit Task 4**

```bash
git add docs/operations/local-production.md docs/development/local-setup.md
git commit -m "docs: add local production operations guide"
```

---

### Task 5: Final Safety Gate

**Files:**
- Verify only; do not add `.env`, `data/`, logs, or PID metadata.

**Interfaces:**
- Consumes: completed local production initialization.
- Produces: evidence-backed handoff with no external writes.

- [ ] **Step 1: Run repository gates**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 2: Run live local health checks**

Run:

```bash
node scripts/local-production-runtime.mjs status
docker compose ps postgres
```

Expected: Web, Worker, and PostgreSQL healthy; mode `mock`.

- [ ] **Step 3: Confirm secret and workspace hygiene**

Run `git status --short`, confirm only `CLAUDE.md` remains untracked, confirm no `.env` or `data/` path is staged, and scan logs using secret hashes rather than printing secret values.

- [ ] **Step 4: Request final code review**

Review Tasks 1–5 for PID safety, secret handling, mock-only enforcement, rollback behavior, and exact operations commands. Fix every P0–P2 issue before handoff.
