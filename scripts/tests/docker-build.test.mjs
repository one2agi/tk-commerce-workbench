import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Dockerfile defines a buildable development target", () => {
  const result = spawnSync(
    "docker",
    ["build", "--check", "--target", "dev", "-f", "Dockerfile", "."],
    { encoding: "utf8" }
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n")
  );
});
