import { spawn } from "node:child_process";

export function resolveBindHost(env = process.env) {
  // ALLOW_LAN only permits configured dependencies (for example PostgreSQL)
  // to use a non-loopback URL. The account-free Web UI remains loopback-only.
  // Docker publishes the container port on host loopback, so the process must
  // explicitly listen on all container interfaces for that mapping to work.
  return env.TK_WEB_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
}

export function buildNextArgs(mode, env = process.env) {
  if (mode !== "dev" && mode !== "start") throw new Error("Expected Next mode: dev or start");
  return [mode, ...(mode === "dev" ? ["--webpack"] : []), "-H", resolveBindHost(env)];
}

const mode = process.argv[2];
const host = resolveBindHost();

if (mode === "host") {
  process.stdout.write(`${host}\n`);
} else if (mode === "args") {
  process.stdout.write(`${JSON.stringify(buildNextArgs(process.argv[3]))}\n`);
} else if (mode === "dev" || mode === "start") {
  const executable = process.platform === "win32" ? "next.cmd" : "next";
  const args = buildNextArgs(mode);
  const child = spawn(executable, args, { env: process.env, stdio: "inherit" });
  child.once("error", (error) => {
    process.stderr.write(`next_start_failed:${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
} else {
  throw new Error("Expected mode: dev, start, host, or args");
}
