import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(
  new URL("../../apps/web/scripts/run-next.mjs", import.meta.url)
);

function runRunner(args, env = {}) {
  return execFileSync(process.execPath, [runner, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  }).trim();
}

test("Web remains loopback-only unless container binding is explicit", () => {
  assert.equal(runRunner(["host"], { TK_WEB_BIND_HOST: "" }), "127.0.0.1");
  assert.equal(runRunner(["host"], { TK_WEB_BIND_HOST: "0.0.0.0" }), "0.0.0.0");
  assert.equal(runRunner(["host"], { TK_WEB_BIND_HOST: "192.168.1.10" }), "127.0.0.1");
});

test("Next arguments carry the resolved container host", () => {
  assert.deepEqual(
    JSON.parse(runRunner(["args", "dev"], { TK_WEB_BIND_HOST: "0.0.0.0" })),
    ["dev", "--webpack", "-H", "0.0.0.0"]
  );
});
