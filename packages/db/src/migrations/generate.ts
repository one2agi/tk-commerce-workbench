import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { INITIAL_SQL } from "./0000_initial.js";

const target = new URL("../../drizzle/0000_initial.sql", import.meta.url);

export async function generateInitialSql(checkOnly = false): Promise<void> {
  const expected = `${INITIAL_SQL.trim()}\n`;
  if (checkOnly) {
    const actual = await readFile(target, "utf8").catch(() => "");
    if (actual !== expected) {
      throw new Error("Generated migration is stale; run db:generate and commit the result");
    }
    return;
  }
  await mkdir(new URL(".", target), { recursive: true });
  await writeFile(target, expected, "utf8");
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  await generateInitialSql(checkOnly);
  process.stdout.write(checkOnly ? "Generated migration is current.\n" : "Generated migration updated.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
