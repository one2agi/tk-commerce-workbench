import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream
} from "node:fs";
import {
  mkdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { DOCKER_PROJECT_NAME, POSTGRES_VOLUME_NAME } from "./config.mjs";

function compactUtcTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function createBackupPaths({ backupRoot, timestamp }) {
  const backupDir = join(backupRoot, timestamp);
  return {
    backupDir,
    databaseFile: join(backupDir, "postgres.dump"),
    assetsFile: join(backupDir, "assets.tar.gz"),
    manifestFile: join(backupDir, "manifest.json")
  };
}

function sha256File(path) {
  return new Promise((resolveResult, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolveResult(hash.digest("hex")));
  });
}

export async function createPairedBackup({
  paths,
  assetDir,
  repoCommit,
  volumeName,
  writeDatabaseDump,
  createAssetArchive
}) {
  await mkdir(paths.backupDir, { recursive: true, mode: 0o700 });
  await writeDatabaseDump(paths.databaseFile);
  await createAssetArchive(paths.assetsFile, assetDir);

  const [databaseStat, assetsStat, databaseSha256, assetsSha256] = await Promise.all([
    stat(paths.databaseFile),
    stat(paths.assetsFile),
    sha256File(paths.databaseFile),
    sha256File(paths.assetsFile)
  ]);
  if (databaseStat.size === 0 || assetsStat.size === 0) {
    throw new Error("paired backup contains an empty artifact");
  }

  const manifest = {
    timestamp: basename(paths.backupDir),
    repoCommit,
    postgres: {
      volume: volumeName,
      file: basename(paths.databaseFile),
      bytes: databaseStat.size,
      sha256: databaseSha256
    },
    assets: {
      source: assetDir,
      file: basename(paths.assetsFile),
      bytes: assetsStat.size,
      sha256: assetsSha256
    }
  };
  await writeFile(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600
  });
  return { ...paths, manifest };
}

export async function writeMigrationMarker({ markerPath, backupDir, repoCommit }) {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  await writeFile(
    markerPath,
    `${JSON.stringify({ backupDir, repoCommit }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function capture(command, args, { cwd, env }) {
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { cwd, env, shell: false });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error((stderr || `${command} exited with ${code}`).trim()));
    });
  });
}

function runToFile(command, args, target, { cwd, env }) {
  return new Promise((resolveResult, reject) => {
    const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(output);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", async (error) => {
      output.destroy();
      await unlink(target).catch(() => undefined);
      reject(error);
    });
    child.once("exit", async (code) => {
      if (code !== 0) {
        output.destroy();
        await unlink(target).catch(() => undefined);
        reject(new Error((stderr || `${command} exited with ${code}`).trim()));
        return;
      }
      output.end(resolveResult);
    });
  });
}

function run(command, args, { cwd, env }) {
  return new Promise((resolveResult, reject) => {
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveResult();
      else reject(new Error((stderr || `${command} exited with ${code}`).trim()));
    });
  });
}

async function postgresContainerId({ repoRoot, env }) {
  const baseArgs = [
    "compose",
    "-p",
    DOCKER_PROJECT_NAME,
    "-f",
    "docker-compose.yml"
  ];
  let id = await capture("docker", [...baseArgs, "ps", "-q", "postgres"], {
    cwd: repoRoot,
    env
  });
  if (!id) {
    await run("docker", [...baseArgs, "up", "-d", "--wait", "postgres"], {
      cwd: repoRoot,
      env
    });
    id = await capture("docker", [...baseArgs, "ps", "-q", "postgres"], {
      cwd: repoRoot,
      env
    });
  }
  if (!id) throw new Error("PostgreSQL service container is not running");
  return id;
}

export async function createLocalDockerBackup({ paths, env, repoRoot }) {
  const timestamp = compactUtcTimestamp();
  const backupPaths = createBackupPaths({ backupRoot: paths.backupDir, timestamp });
  const [containerId, repoCommit] = await Promise.all([
    postgresContainerId({ repoRoot, env }),
    capture("git", ["rev-parse", "HEAD"], { cwd: repoRoot, env })
  ]);

  return createPairedBackup({
    paths: backupPaths,
    assetDir: paths.assetDir,
    repoCommit,
    volumeName: POSTGRES_VOLUME_NAME,
    writeDatabaseDump: (target) => runToFile(
      "docker",
      ["exec", containerId, "pg_dump", "-U", "postgres", "-d", "tk_workbench", "-Fc"],
      target,
      { cwd: repoRoot, env }
    ),
    createAssetArchive: (target, assetDir) => run(
      "tar",
      ["-czf", target, "-C", assetDir, "."],
      { cwd: repoRoot, env }
    )
  });
}
