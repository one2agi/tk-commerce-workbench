import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream
} from "node:fs";
import {
  mkdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

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
  const stagingPaths = createBackupPaths({
    backupRoot: dirname(paths.backupDir),
    timestamp: `.${basename(paths.backupDir)}.partial-${randomUUID()}`
  });
  await mkdir(dirname(paths.backupDir), { recursive: true, mode: 0o700 });
  await mkdir(stagingPaths.backupDir, { recursive: false, mode: 0o700 });
  try {
    await writeDatabaseDump(stagingPaths.databaseFile);
    await createAssetArchive(stagingPaths.assetsFile, assetDir);

    const [databaseStat, assetsStat, databaseSha256, assetsSha256] = await Promise.all([
      stat(stagingPaths.databaseFile),
      stat(stagingPaths.assetsFile),
      sha256File(stagingPaths.databaseFile),
      sha256File(stagingPaths.assetsFile)
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
    await writeFile(stagingPaths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600
    });
    await rename(stagingPaths.backupDir, paths.backupDir);
    return { ...paths, manifest };
  } catch (error) {
    await rm(stagingPaths.backupDir, { recursive: true, force: true });
    throw error;
  }
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

async function runToFile(command, args, target, { cwd, env }) {
  const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
  let stderr = "";
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`));
      else if (code === 0) resolveResult();
      else reject(new Error((stderr || `${command} exited with ${code}`).trim()));
    });
  });
  const streamed = pipeline(child.stdout, output).catch((error) => {
    child.kill("SIGTERM");
    throw error;
  });
  const results = await Promise.allSettled([streamed, exited]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    await unlink(target).catch(() => undefined);
    throw failure.reason;
  }
}

async function runFromFile(command, args, source, { cwd, env }) {
  const input = createReadStream(source);
  let stderr = "";
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`));
      else if (code === 0) resolveResult();
      else reject(new Error((stderr || `${command} exited with ${code}`).trim()));
    });
  });
  const streamed = pipeline(input, child.stdin).catch((error) => {
    child.kill("SIGTERM");
    throw error;
  });
  const results = await Promise.allSettled([streamed, exited]);
  const failure = results[1].status === "rejected" ? results[1] :
    results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
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
  await capture("docker", ["volume", "inspect", POSTGRES_VOLUME_NAME], {
    cwd: repoRoot,
    env
  }).catch(() => {
    throw new Error(`required PostgreSQL volume is missing: ${POSTGRES_VOLUME_NAME}`);
  });
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
  const mounts = JSON.parse(await capture("docker", ["inspect", "--format", "{{json .Mounts}}", id], {
    cwd: repoRoot,
    env
  }));
  assertExpectedPostgresVolume(mounts);
  return id;
}

export function assertExpectedPostgresVolume(mounts) {
  const matched = Array.isArray(mounts) && mounts.some((mount) =>
    mount?.Type === "volume" &&
    mount?.Name === POSTGRES_VOLUME_NAME &&
    mount?.Destination === "/var/lib/postgresql/data"
  );
  if (!matched) throw new Error(`PostgreSQL container is not using required volume: ${POSTGRES_VOLUME_NAME}`);
}

export async function runWithApplicationPause({
  containerIds,
  stopApplications,
  startApplications,
  restartApplications = true,
  task
}) {
  let result;
  let failure;
  try {
    if (containerIds.length > 0) await stopApplications(containerIds);
    result = await task();
  } catch (error) {
    failure = error;
  }
  if (restartApplications && containerIds.length > 0) {
    try {
      await startApplications(containerIds);
    } catch (error) {
      failure = failure ?
        new AggregateError([failure, error], "backup failed and applications could not be resumed") :
        error;
    }
  }
  if (failure) throw failure;
  return result;
}

async function runningApplicationContainerIds({ repoRoot, env }) {
  const ids = [];
  for (const service of ["web", "worker"]) {
    const output = await capture("docker", [
      "ps", "-q",
      "--filter", `label=com.docker.compose.project=${DOCKER_PROJECT_NAME}`,
      "--filter", `label=com.docker.compose.service=${service}`
    ], { cwd: repoRoot, env });
    if (output) ids.push(...output.split(/\s+/).filter(Boolean));
  }
  return [...new Set(ids)];
}

export async function createLocalDockerBackup({
  paths,
  env,
  repoRoot,
  restartApplications = true
}) {
  const applicationIds = await runningApplicationContainerIds({ repoRoot, env });
  return runWithApplicationPause({
    containerIds: applicationIds,
    restartApplications,
    stopApplications: (ids) => run("docker", ["stop", ...ids], { cwd: repoRoot, env }),
    startApplications: (ids) => run("docker", ["start", ...ids], { cwd: repoRoot, env }),
    task: async () => {
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
        writeDatabaseDump: async (target) => {
          await runToFile(
            "docker",
            ["exec", containerId, "pg_dump", "-U", "postgres", "-d", "tk_workbench", "-Fc"],
            target,
            { cwd: repoRoot, env }
          );
          await runFromFile(
            "docker",
            ["exec", "-i", containerId, "pg_restore", "--list"],
            target,
            { cwd: repoRoot, env }
          );
        },
        createAssetArchive: (target, assetDir) => run(
          "tar",
          ["-czf", target, "-C", assetDir, "."],
          { cwd: repoRoot, env }
        )
      });
    }
  });
}
