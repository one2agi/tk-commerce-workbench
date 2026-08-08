import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  POSTGRES_VOLUME_NAME,
  buildComposeArgs,
  buildDockerEnvironment,
  resolveDockerPaths,
  validateImageTag
} from "./config.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELP_TEXT = `Usage: node scripts/docker-local.mjs <action> [argument]

Actions:
  dev:up                 Build and start the hot-reload stack
  dev:down               Stop containers without deleting data
  dev:status             Show Compose and HTTP readiness
  dev:logs [service]     Follow logs for web, worker, postgres, or all
  prod:build             Build immutable Web and Worker images
  prod:up                Start production Compose using TK_IMAGE_TAG
  prod:down              Stop production containers without deleting data
  backup                 Back up PostgreSQL and assets as one pair
  image:export <path>    Save Web and Worker images to one archive
  image:import <path>    Load Web and Worker images from an archive
  help                   Show this help
`;

function runCommand(command, args, {
  cwd = REPO_ROOT,
  env = process.env,
  capture = false
} = {}) {
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`));
      else if (code === 0) resolveResult({ stdout, stderr });
      else reject(new Error((stderr || stdout || `${command} exited with ${code}`).trim()));
    });
  });
}

function portOpen(host, port, timeoutMs = 1_000) {
  return new Promise((resolveResult) => {
    const socket = netConnect({ host, port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveResult(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function currentImageTag() {
  const result = await runCommand("git", ["rev-parse", "--short", "HEAD"], { capture: true });
  return validateImageTag(result.stdout.trim());
}

async function assertPath(path, label) {
  await access(path).catch(() => {
    throw new Error(`${label} is missing: ${path}`);
  });
}

async function composeServiceId(mode, service, env) {
  const result = await runCommand(
    "docker",
    buildComposeArgs({ mode, operation: ["ps", "-q", service] }),
    { env, capture: true }
  ).catch(() => ({ stdout: "" }));
  return result.stdout.trim();
}

async function preflight({ mode, paths, env }) {
  await runCommand("docker", ["info"], { env, capture: true }).catch(() => {
    throw new Error("Docker daemon is unavailable");
  });
  await assertPath(paths.envFile, "Docker environment file");
  await assertPath(paths.assetDir, "Docker asset directory");

  if (mode === "dev") {
    await runCommand("docker", ["volume", "inspect", POSTGRES_VOLUME_NAME], {
      env,
      capture: true
    }).catch(() => {
      throw new Error(`required PostgreSQL volume is missing: ${POSTGRES_VOLUME_NAME}`);
    });

    const existingWeb = await composeServiceId("dev", "web", env);
    if (!existingWeb && await portOpen("127.0.0.1", Number(env.TK_WEB_PORT || "3000"))) {
      throw new Error(`Web port is already occupied: 127.0.0.1:${env.TK_WEB_PORT || "3000"}`);
    }
  }
}

async function dockerCompose(mode, operation, env, options = {}) {
  return runCommand("docker", buildComposeArgs({ mode, operation }), {
    env,
    capture: options.capture ?? false
  });
}

async function buildProductionImages(tag, env) {
  await runCommand("docker", [
    "build", "--target", "web-runner", "-t", `tk-commerce-workbench-web:${tag}`, "."
  ], { env });
  await runCommand("docker", [
    "build", "--target", "worker-runner", "-t", `tk-commerce-workbench-worker:${tag}`, "."
  ], { env });
}

export async function runDockerCli(argv, { baseEnv = process.env } = {}) {
  const [action = "help", argument] = argv;
  if (action === "help" || action === "--help" || action === "-h") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if ((action === "image:export" || action === "image:import") && !argument) {
    throw new Error("image archive path is required");
  }

  const paths = resolveDockerPaths({ env: baseEnv });
  const requestedTag = baseEnv.TK_IMAGE_TAG;
  const imageTag = requestedTag ? validateImageTag(requestedTag) : await currentImageTag();
  const env = buildDockerEnvironment({ baseEnv, paths, imageTag });

  if (action === "dev:up") {
    await preflight({ mode: "dev", paths, env });
    let migrationBackup;
    const markerExists = await access(paths.migrationMarker).then(() => true, () => false);
    if (!markerExists) {
      const { createLocalDockerBackup } = await import("./backup.mjs");
      migrationBackup = await createLocalDockerBackup({ paths, env, repoRoot: REPO_ROOT });
    }
    await runCommand("docker", ["build", "--target", "dev", "-t", "tk-commerce-workbench:dev", "."], { env });
    await dockerCompose("dev", ["up", "-d", "--wait"], env);
    if (migrationBackup) {
      const { writeMigrationMarker } = await import("./backup.mjs");
      await writeMigrationMarker({
        markerPath: paths.migrationMarker,
        backupDir: migrationBackup.backupDir,
        repoCommit: migrationBackup.manifest.repoCommit
      });
    }
    process.stdout.write("Docker development stack is ready at http://127.0.0.1:3000\n");
    return;
  }
  if (action === "dev:down") {
    await dockerCompose("dev", ["down", "--remove-orphans"], env);
    return;
  }
  if (action === "dev:status") {
    await preflight({ mode: "dev", paths, env });
    const status = await dockerCompose("dev", ["ps"], env, { capture: true });
    process.stdout.write(status.stdout);
    const response = await fetch("http://127.0.0.1:3000/api/runtime-health");
    if (!response.ok) throw new Error(`runtime health returned HTTP ${response.status}`);
    process.stdout.write(`${JSON.stringify(await response.json())}\n`);
    return;
  }
  if (action === "dev:logs") {
    const allowed = new Set([undefined, "web", "worker", "postgres", "migrate"]);
    if (!allowed.has(argument)) throw new Error("log service must be web, worker, postgres, or migrate");
    await dockerCompose("dev", ["logs", "--follow", ...(argument ? [argument] : [])], env);
    return;
  }
  if (action === "prod:build") {
    await preflight({ mode: "prod", paths, env });
    await buildProductionImages(imageTag, env);
    process.stdout.write(`Built production images with tag ${imageTag}\n`);
    return;
  }
  if (action === "prod:up") {
    if (!requestedTag) throw new Error("TK_IMAGE_TAG is required for production start");
    await preflight({ mode: "prod", paths, env });
    await dockerCompose("prod", ["up", "-d", "--wait"], env);
    return;
  }
  if (action === "prod:down") {
    await dockerCompose("prod", ["down", "--remove-orphans"], env);
    return;
  }
  if (action === "image:export") {
    await runCommand("docker", [
      "save", "-o", resolve(argument),
      `tk-commerce-workbench-web:${imageTag}`,
      `tk-commerce-workbench-worker:${imageTag}`
    ], { env });
    return;
  }
  if (action === "image:import") {
    await runCommand("docker", ["load", "-i", resolve(argument)], { env });
    return;
  }
  if (action === "backup") {
    const { createLocalDockerBackup } = await import("./backup.mjs");
    const result = await createLocalDockerBackup({ paths, env, repoRoot: REPO_ROOT });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error(`unknown Docker action: ${action}`);
}
