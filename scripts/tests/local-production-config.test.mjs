import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeLocalProduction,
  parseMiaoshouCredentials
} from "../local-production-config.mjs";

test("parses labeled Miaoshou credentials across CRLF or whitespace", () => {
  assert.deepEqual(
    parseMiaoshouCredentials("APP ID: demo-id\r\nAPP Secret: demo-secret"),
    {
      appKey: "demo-id",
      appSecret: "demo-secret"
    }
  );
});

test("rejects credential values that are unsafe to render in an env file", () => {
  const unsafeCredentials = [
    "APP ID: demo=id\nAPP Secret: demo-secret",
    "APP ID: demo-id\nAPP Secret: demo\0secret",
    "APP ID:\nINJECTED\nAPP Secret: demo-secret"
  ];

  for (const credentials of unsafeCredentials) {
    assert.throws(() => parseMiaoshouCredentials(credentials), /invalid|required/i);
  }
});

test("creates a private mock-only env and runtime directories", async () => {
  const permissionCapableTempRoot =
    process.platform === "linux" ? "/tmp" : tmpdir();
  const repoRoot = await mkdtemp(
    join(permissionCapableTempRoot, "tk-local-production-")
  );
  const credentialFile = join(repoRoot, "credentials.txt");
  await writeFile(
    credentialFile,
    "APP ID: demo-id\nAPP Secret: demo-secret"
  );
  await initializeLocalProduction({
    repoRoot,
    credentialFile,
    outputFile: join(repoRoot, ".env")
  });
  const env = await readFile(join(repoRoot, ".env"), "utf8");
  assert.match(env, /^EXTERNAL_ADAPTER_MODE=mock$/m);
  assert.match(env, /^ALLOW_LAN=false$/m);
  assert.match(env, /^MIAOSHOU_APP_KEY=demo-id$/m);
  assert.match(env, /^EXTENSION_TOKEN=[A-Za-z0-9_-]{43}$/m);
  const assetDirectory = await stat(join(repoRoot, "data/assets"));
  const runtimeDirectory = await stat(join(repoRoot, "data/runtime"));
  assert.equal(assetDirectory.isDirectory(), true);
  assert.equal(runtimeDirectory.isDirectory(), true);

  if (process.platform !== "win32") {
    assert.equal(assetDirectory.mode & 0o777, 0o700);
    assert.equal(runtimeDirectory.mode & 0o777, 0o700);
    assert.equal((await stat(join(repoRoot, ".env"))).mode & 0o777, 0o600);
  }
});

test("rejects a non-repository env path before reading credentials", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-local-production-path-"));
  const credentialFile = join(repoRoot, "missing-credentials.txt");
  const outputFile = join(repoRoot, ".env.local");

  await assert.rejects(
    () => initializeLocalProduction({ repoRoot, credentialFile, outputFile }),
    /output.*repository.*\.env/i
  );
});

test("refuses to overwrite an existing env", async () => {
  const repoRoot = await mkdtemp(
    join(tmpdir(), "tk-local-production-existing-")
  );
  const outputFile = join(repoRoot, ".env");
  const credentialFile = join(repoRoot, "credentials.txt");
  await writeFile(outputFile, "KEEP=1\n");
  await writeFile(
    credentialFile,
    "APP ID: demo-id\nAPP Secret: demo-secret"
  );
  await assert.rejects(
    () => initializeLocalProduction({ repoRoot, credentialFile, outputFile }),
    /already exists/
  );
});
