import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const runNodeTest = args.length > 0 && args.every((arg) =>
  /^scripts\/tests\/.*\.(?:test|spec)\.mjs$/.test(arg)
);
const command = runNodeTest ? process.execPath : "vitest";
const commandArgs = runNodeTest ? ["--test", ...args] : ["run", ...args];

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
