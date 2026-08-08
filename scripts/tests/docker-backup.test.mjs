import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const backupModule = await import("../docker/backup.mjs").catch(() => ({}));

function callBackup(name, ...args) {
  assert.equal(typeof backupModule[name], "function", `${name} must be exported`);
  return backupModule[name](...args);
}

test("backup files share one timestamped directory", () => {
  assert.deepEqual(
    callBackup("createBackupPaths", {
      backupRoot: "/backup",
      timestamp: "20260808T120000Z"
    }),
    {
      backupDir: "/backup/20260808T120000Z",
      databaseFile: "/backup/20260808T120000Z/postgres.dump",
      assetsFile: "/backup/20260808T120000Z/assets.tar.gz",
      manifestFile: "/backup/20260808T120000Z/manifest.json"
    }
  );
});

test("failed database dump leaves no asset archive or success manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "tk-backup-failure-"));
  const paths = callBackup("createBackupPaths", {
    backupRoot: root,
    timestamp: "20260808T120000Z"
  });

  await assert.rejects(
    () => callBackup("createPairedBackup", {
      paths,
      assetDir: root,
      repoCommit: "abc1234",
      volumeName: "tk-commerce-workbench_postgres_data",
      writeDatabaseDump: async () => { throw new Error("dump failed"); },
      createAssetArchive: async () => writeFile(paths.assetsFile, "should-not-exist")
    }),
    /dump failed/
  );

  await assert.rejects(access(paths.assetsFile));
  await assert.rejects(access(paths.manifestFile));
  await rm(root, { recursive: true, force: true });
});

test("successful paired backup writes digests and non-secret source metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "tk-backup-success-"));
  const paths = callBackup("createBackupPaths", {
    backupRoot: root,
    timestamp: "20260808T120000Z"
  });

  const result = await callBackup("createPairedBackup", {
    paths,
    assetDir: "/srv/tk/assets",
    repoCommit: "abc1234",
    volumeName: "tk-commerce-workbench_postgres_data",
    writeDatabaseDump: async (target) => writeFile(target, "database-bytes"),
    createAssetArchive: async (target) => writeFile(target, "asset-bytes")
  });

  const manifest = JSON.parse(await readFile(paths.manifestFile, "utf8"));
  assert.equal(result.manifestFile, paths.manifestFile);
  assert.equal(manifest.timestamp, "20260808T120000Z");
  assert.equal(manifest.repoCommit, "abc1234");
  assert.equal(manifest.postgres.volume, "tk-commerce-workbench_postgres_data");
  assert.equal(manifest.assets.source, "/srv/tk/assets");
  assert.equal(manifest.postgres.bytes, 14);
  assert.equal(manifest.assets.bytes, 11);
  assert.match(manifest.postgres.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.assets.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(manifest), /password|token|secret/i);
  await rm(root, { recursive: true, force: true });
});

test("migration marker references only the verified backup and commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tk-backup-marker-"));
  const markerPath = join(root, ".docker-migration-complete.json");
  await callBackup("writeMigrationMarker", {
    markerPath,
    backupDir: join(root, "20260808T120000Z"),
    repoCommit: "abc1234"
  });

  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.deepEqual(marker, {
    backupDir: join(root, "20260808T120000Z"),
    repoCommit: "abc1234"
  });
  assert.doesNotMatch(JSON.stringify(marker), /password|token|secret/i);
  await rm(root, { recursive: true, force: true });
});
