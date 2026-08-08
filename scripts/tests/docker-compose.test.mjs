import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function renderCompose(mode) {
  const root = await mkdtemp(join(tmpdir(), "tk-compose-test-"));
  const envFile = join(root, ".env");
  const assetDir = join(root, "assets");
  await mkdir(assetDir);
  await writeFile(
    envFile,
    [
      "LOCAL_OPERATOR_ID=test-operator",
      "EXTENSION_TOKEN=test-token",
      "EXTERNAL_ADAPTER_MODE=mock",
      "ALLOW_LAN=false"
    ].join("\n") + "\n"
  );

  const overlay = mode === "dev" ? "compose.dev.yml" : "compose.prod.yml";
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      `tk-compose-${mode}-test`,
      "-f",
      "docker-compose.yml",
      "-f",
      overlay,
      "config",
      "--format",
      "json"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TK_WORKBENCH_ENV_FILE: envFile,
        TK_WORKBENCH_ASSET_DIR: assetDir,
        TK_IMAGE_TAG: "test-image-tag",
        TK_WEB_PORT: "3000"
      }
    }
  );

  await rm(root, { recursive: true, force: true });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n")
  );
  return JSON.parse(result.stdout);
}

test("development Compose renders hot reload and protected local persistence", async () => {
  const config = await renderCompose("dev");
  const web = config.services.web;
  const worker = config.services.worker;

  assert.equal(web.ports[0].host_ip, "127.0.0.1");
  assert.equal(web.ports[0].published, "3000");
  assert.equal(web.environment.TK_WEB_BIND_HOST, "0.0.0.0");
  assert.equal(web.environment.WATCHPACK_POLLING, "true");
  assert.equal(worker.environment.CHOKIDAR_USEPOLLING, "true");
  assert.equal(config.volumes.postgres_data.external, true);
  assert.equal(config.volumes.postgres_data.name, "tk-commerce-workbench_postgres_data");
  assert.ok(web.volumes.some((volume) => volume.source.endsWith("/apps/web/src")));
  assert.ok(worker.volumes.some((volume) => volume.source.endsWith("/apps/worker/src")));
});

test("production Compose uses immutable images without source or database ports", async () => {
  const config = await renderCompose("prod");
  assert.equal(config.services.web.image, "tk-commerce-workbench-web:test-image-tag");
  assert.equal(config.services.worker.image, "tk-commerce-workbench-worker:test-image-tag");
  assert.deepEqual(config.services.postgres.ports ?? [], []);

  for (const service of [config.services.web, config.services.worker]) {
    assert.equal(
      (service.volumes ?? []).some((volume) => String(volume.source).includes("/src")),
      false
    );
  }
});
