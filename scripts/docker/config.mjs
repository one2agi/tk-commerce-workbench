import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DOCKER_PROJECT_NAME = "tk-commerce-workbench";
export const POSTGRES_VOLUME_NAME = "tk-commerce-workbench_postgres_data";

export function resolveDockerPaths({ env = process.env, homeDir = homedir() } = {}) {
  const storageDir = resolve(
    env.TK_WORKBENCH_STORAGE_DIR ||
      join(homeDir, ".local", "share", "tk-commerce-workbench")
  );
  const backupDir = join(storageDir, "data", "backups");
  return {
    storageDir,
    envFile: join(storageDir, ".env"),
    assetDir: join(storageDir, "data", "assets"),
    backupDir,
    migrationMarker: join(backupDir, ".docker-migration-complete.json")
  };
}

export function validateImageTag(value) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value ?? "")) {
    throw new Error("invalid Docker image tag");
  }
  return value;
}

export function buildComposeArgs({
  mode,
  operation,
  projectName = DOCKER_PROJECT_NAME
}) {
  if (mode !== "dev" && mode !== "prod") {
    throw new Error("Docker mode must be dev or prod");
  }
  if (operation.some((value) => value === "-v" || value === "--volumes")) {
    throw new Error("Docker volume deletion is not allowed");
  }
  return [
    "compose",
    "-p",
    projectName,
    "-f",
    "docker-compose.yml",
    "-f",
    mode === "dev" ? "compose.dev.yml" : "compose.prod.yml",
    ...operation
  ];
}

export function buildDockerEnvironment({
  baseEnv = process.env,
  paths,
  imageTag
}) {
  return {
    ...baseEnv,
    TK_WORKBENCH_ENV_FILE: paths.envFile,
    TK_WORKBENCH_ASSET_DIR: paths.assetDir,
    ...(imageTag ? { TK_IMAGE_TAG: validateImageTag(imageTag) } : {})
  };
}
