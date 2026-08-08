import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseDockerCliArguments } from "../docker/cli.mjs";

const cli = fileURLToPath(new URL("../docker-local.mjs", import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, SECRET_SENTINEL: "must-not-appear" }
  });
}

test("Docker CLI help exposes supported lifecycle actions without environment values", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const action of [
    "dev:up",
    "dev:down",
    "dev:status",
    "dev:logs",
    "prod:build",
    "prod:up",
    "prod:down",
    "backup",
    "image:export",
    "image:import"
  ]) {
    assert.match(result.stdout, new RegExp(action.replace(":", "\\:")));
  }
  assert.doesNotMatch(result.stdout + result.stderr, /must-not-appear/);
});

test("Docker CLI rejects unknown actions without a stack trace", () => {
  const result = runCli(["destroy:everything"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown Docker action/);
  assert.doesNotMatch(result.stderr, /\n\s+at\s/);
});

test("image export requires an explicit archive path", () => {
  const result = runCli(["image:export"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /image archive path is required/);
});

test("image actions accept pnpm's forwarded argument separator", () => {
  assert.deepEqual(
    parseDockerCliArguments(["image:export", "--", "/tmp/images.tar"]),
    { action: "image:export", argument: "/tmp/images.tar" }
  );
  assert.deepEqual(
    parseDockerCliArguments(["image:import", "/tmp/images.tar"]),
    { action: "image:import", argument: "/tmp/images.tar" }
  );
});
