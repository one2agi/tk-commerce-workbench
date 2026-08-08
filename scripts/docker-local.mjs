#!/usr/bin/env node
import { runDockerCli } from "./docker/cli.mjs";

runDockerCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
