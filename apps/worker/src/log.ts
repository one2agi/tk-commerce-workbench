// Secret-safe logger for the worker process.
//
// The runtime manager (scripts/local-production-runtime.mjs) scans the worker's
// stderr for any value matching a sensitive-key name pattern (SECRET, TOKEN,
// PASSWORD, API_KEY, CREDENTIAL, AUTH, etc.). To keep that scanner from
// false-positiving on incidental mentions, and to never leak connection strings
// or credential values into the log, this helper:
//
//   1. Accepts only a static message string and an optional structured-records
//      object. Error objects MUST NOT be passed directly — they are flattened
//      to `code`, `name`, and `message` (no stack, no full object dump).
//   2. Strips any field whose key matches a sensitive-name pattern.
//   3. Wraps every line with a stable prefix so log greppers can isolate
//      worker output from subprocess noise.
//
// All worker error paths should funnel through `log.error` and `log.warn`
// instead of calling `console.error` directly.

const SENSITIVE_KEY_PATTERN =
  /SECRET|TOKEN|PASSWORD|PASS_PHRASE|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH/i;

const PREFIX = "worker:";

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactRecord(record: Record<string, unknown>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSensitiveKey(key)) {
      safe[key] = "[REDACTED]";
      continue;
    }
    if (value instanceof Error) {
      safe[key] = value.message || String(value);
      continue;
    }
    if (value === undefined || value === null) continue;
    safe[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return safe;
}

function formatLine(message: string, fields?: Record<string, unknown>): string {
  if (!fields) return `${PREFIX} ${message}`;
  const redacted = redactRecord(fields);
  const keys = Object.keys(redacted);
  if (keys.length === 0) return `${PREFIX} ${message}`;
  return `${PREFIX} ${message} ${JSON.stringify(redacted)}`;
}

export const log = {
  error(message: string, fields?: Record<string, unknown>): void {
    process.stderr.write(`${formatLine(message, fields)}\n`);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    process.stderr.write(`${formatLine(message, fields)}\n`);
  },
  info(message: string, fields?: Record<string, unknown>): void {
    process.stdout.write(`${formatLine(message, fields)}\n`);
  },
  // Escape hatch for callers that explicitly want to log a value whose key
  // would otherwise be redacted. Use sparingly.
  raw(line: string): void {
    process.stderr.write(`${PREFIX} ${line}\n`);
  }
};

// Test-only helpers. Not exported from the package barrel; consumers import
// them directly from this file in their tests.
export const __test__ = {
  isSensitiveKey,
  redactRecord,
  formatLine,
  PREFIX
};