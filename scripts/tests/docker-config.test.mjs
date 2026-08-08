import assert from "node:assert/strict";
import test from "node:test";

const dockerConfig = await import("../docker/config.mjs").catch(() => ({}));

function callConfig(name, ...args) {
  assert.equal(typeof dockerConfig[name], "function", `${name} must be exported`);
  return dockerConfig[name](...args);
}

test("Docker paths reuse the established local storage layout", () => {
  assert.deepEqual(callConfig("resolveDockerPaths", { homeDir: "/home/test", env: {} }), {
    storageDir: "/home/test/.local/share/tk-commerce-workbench",
    envFile: "/home/test/.local/share/tk-commerce-workbench/.env",
    assetDir: "/home/test/.local/share/tk-commerce-workbench/data/assets",
    backupDir: "/home/test/.local/share/tk-commerce-workbench/data/backups",
    migrationMarker: "/home/test/.local/share/tk-commerce-workbench/data/backups/.docker-migration-complete.json"
  });
});

test("Docker paths honor an explicit storage directory", () => {
  assert.equal(
    callConfig("resolveDockerPaths", {
      homeDir: "/home/ignored",
      env: { TK_WORKBENCH_STORAGE_DIR: "/srv/tk" }
    }).envFile,
    "/srv/tk/.env"
  );
});

test("Compose invocations use fixed project and mode files without destructive flags", () => {
  assert.deepEqual(
    callConfig("buildComposeArgs", { mode: "dev", operation: ["down", "--remove-orphans"] }),
    [
      "compose",
      "-p",
      "tk-commerce-workbench",
      "-f",
      "docker-compose.yml",
      "-f",
      "compose.dev.yml",
      "down",
      "--remove-orphans"
    ]
  );
  assert.throws(
    () => callConfig("buildComposeArgs", { mode: "dev", operation: ["down", "-v"] }),
    /volume deletion is not allowed/
  );
});

test("Docker environment exposes only path selectors and a validated image tag", () => {
  const paths = callConfig("resolveDockerPaths", { homeDir: "/home/test", env: {} });
  const env = callConfig("buildDockerEnvironment", {
    baseEnv: { PATH: "/bin", SECRET_VALUE: "preserved-for-child" },
    paths,
    imageTag: "abc1234"
  });

  assert.equal(env.TK_WORKBENCH_ENV_FILE, paths.envFile);
  assert.equal(env.TK_WORKBENCH_ASSET_DIR, paths.assetDir);
  assert.equal(env.TK_IMAGE_TAG, "abc1234");
  assert.equal(env.SECRET_VALUE, "preserved-for-child");
});

test("image tags reject shell and path syntax", () => {
  assert.equal(callConfig("validateImageTag", "release-2026.08.08"), "release-2026.08.08");
  for (const value of ["", "latest;rm", "../tag", "tag with spaces"]) {
    assert.throws(() => callConfig("validateImageTag", value), /invalid Docker image tag/);
  }
});

test("Web readiness uses the configured published port", () => {
  assert.equal(callConfig("resolveWebUrl", {}), "http://127.0.0.1:3000");
  assert.equal(callConfig("resolveWebUrl", { TK_WEB_PORT: "3001" }), "http://127.0.0.1:3001");
  assert.throws(() => callConfig("resolveWebUrl", { TK_WEB_PORT: "70000" }), /invalid Docker Web port/);
});

test("production image tags cannot describe uncommitted source", () => {
  assert.doesNotThrow(() => callConfig("assertCleanProductionSource", "\n"));
  assert.throws(
    () => callConfig("assertCleanProductionSource", " M apps/web/src/app.tsx\n"),
    /clean Git worktree/
  );
});
