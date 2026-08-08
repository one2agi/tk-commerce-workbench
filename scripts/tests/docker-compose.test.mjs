import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function renderCompose(mode, environment = {}) {
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
        TK_WEB_PORT: "3000",
        ...environment
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
  assert.equal(web.environment.ALLOW_LAN, "true");
  assert.equal(web.environment.TK_RUNTIME_LAUNCH_ID, "docker-dev");
  assert.equal(web.environment.WATCHPACK_POLLING, "true");
  assert.equal(worker.environment.CHOKIDAR_USEPOLLING, "true");
  assert.equal(worker.environment.TK_WORKER_READY_PATH, "/tmp/tk-worker-ready.json");
  assert.match(worker.command.join(" "), /rm -f \/tmp\/tk-worker-ready\.json/);
  assert.equal(config.volumes.postgres_data.external, true);
  assert.equal(config.volumes.postgres_data.name, "tk-commerce-workbench_postgres_data");
  assert.ok(web.volumes.some((volume) => volume.source.endsWith("/apps/web/src")));
  assert.ok(worker.volumes.some((volume) => volume.source.endsWith("/apps/worker/src")));
  assert.equal(config.services["assets-check"].restart, "no");
  assert.equal(config.volumes.web_next, undefined);
});

test("production Compose uses immutable images without source or database ports", async () => {
  const config = await renderCompose("prod");
  assert.equal(config.services.web.image, "tk-commerce-workbench-web:test-image-tag");
  assert.equal(config.services.worker.image, "tk-commerce-workbench-worker:test-image-tag");
  assert.equal(config.services.web.environment.ALLOW_LAN, "true");
  assert.equal(config.services.web.environment.TK_RUNTIME_LAUNCH_ID, "docker-test-image-tag");
  assert.equal(config.services.worker.environment.TK_WORKER_READY_PATH, "/tmp/tk-worker-ready.json");
  assert.match(config.services.worker.command.join(" "), /rm -f \/tmp\/tk-worker-ready\.json/);
  assert.equal(config.services["assets-check"].image, "tk-commerce-workbench-worker:test-image-tag");
  assert.match(config.services.migrate.command.join(" "), /runInitialMigration/);
  assert.deepEqual(config.services.postgres.ports ?? [], []);

  for (const service of [config.services.web, config.services.worker]) {
    assert.equal(
      (service.volumes ?? []).some((volume) => String(volume.source).includes("/src")),
      false
    );
  }
});

test("production Compose accepts registry-qualified image repositories", async () => {
  const config = await renderCompose("prod", {
    TK_WEB_IMAGE: "registry.example.com/tk/workbench-web",
    TK_WORKER_IMAGE: "registry.example.com/tk/workbench-worker"
  });

  assert.equal(
    config.services.web.image,
    "registry.example.com/tk/workbench-web:test-image-tag"
  );
  assert.equal(
    config.services.worker.image,
    "registry.example.com/tk/workbench-worker:test-image-tag"
  );
  assert.equal(
    config.services.migrate.image,
    "registry.example.com/tk/workbench-worker:test-image-tag"
  );
});
