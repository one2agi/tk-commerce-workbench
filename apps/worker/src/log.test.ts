import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";

import { __test__, log } from "./log.js";

function captureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    }
  });
  return { stream, lines };
}

describe("worker redacting logger", () => {
  describe("sensitive-key detection", () => {
    it.each([
      "SECRET",
      "MIAOSHOU_APP_SECRET",
      "EXTENSION_TOKEN",
      "DATABASE_PASSWORD",
      "API_KEY",
      "CANVAS_API_KEY",
      "LLM_API_KEY",
      "PRIVATE_KEY",
      "AUTH_HEADER",
      "CREDENTIAL_BLOB"
    ])("flags %s as sensitive", (key) => {
      expect(__test__.isSensitiveKey(key)).toBe(true);
    });

    it.each(["PATH", "HOME", "DATABASE_URL", "PGAPPNAME", "NODE_ENV"])(
      "does not flag %s as sensitive",
      (key) => {
        expect(__test__.isSensitiveKey(key)).toBe(false);
      }
    );
  });

  describe("redactRecord", () => {
    it("replaces sensitive field values with [REDACTED]", () => {
      const out = __test__.redactRecord({
        MIAOSHOU_APP_SECRET: "real-secret-value",
        PATH: "/usr/bin",
        EXTENSION_TOKEN: "tk-extension-token-value"
      });
      expect(out.MIAOSHOU_APP_SECRET).toBe("[REDACTED]");
      expect(out.PATH).toBe("/usr/bin");
      expect(out.EXTENSION_TOKEN).toBe("[REDACTED]");
    });

    it("serializes Error objects to their message only — no stack, no object dump", () => {
      const error = new Error("connection terminated");
      const out = __test__.redactRecord({ cause: error });
      expect(out.cause).toBe("connection terminated");
      expect(JSON.stringify(out)).not.toMatch(/at\s+/);
    });

    it("omits undefined and null values", () => {
      const out = __test__.redactRecord({
        PATH: "/usr/bin",
        PRESENT: "x",
        MISSING: undefined,
        NULLY: null
      });
      expect(out).toEqual({ PATH: "/usr/bin", PRESENT: "x" });
    });
  });

  describe("formatLine", () => {
    it("produces a static worker-prefixed line", () => {
      expect(__test__.formatLine("database pool error")).toBe(
        "worker: database pool error"
      );
    });

    it("appends redacted records as JSON", () => {
      const line = __test__.formatLine("worker started", {
        PATH: "/usr/bin",
        MIAOSHOU_APP_SECRET: "leaked-value"
      });
      expect(line.startsWith("worker: worker started ")).toBe(true);
      expect(line).not.toContain("leaked-value");
      expect(line).toContain("\"MIAOSHOU_APP_SECRET\":\"[REDACTED]\"");
      expect(line).toContain("\"PATH\":\"/usr/bin\"");
    });
  });

  describe("log.error writes through process.stderr", () => {
    let stderrLines: string[];
    let originalStderrWrite: typeof process.stderr.write;
    let originalStdoutWrite: typeof process.stdout.write;

    beforeEach(() => {
      const stderrCapture = captureStream();
      const stdoutCapture = captureStream();
      stderrLines = stderrCapture.lines;
      originalStderrWrite = process.stderr.write.bind(process.stderr);
      originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stderr.write = stderrCapture.stream.write.bind(stderrCapture.stream);
      process.stdout.write = stdoutCapture.stream.write.bind(stdoutCapture.stream);
      // Reference stdoutCapture so unused-variable lint doesn't fire; the
      // pointer is held only to keep the writable sink alive for the
      // duration of the test.
      void stdoutCapture;
    });

    afterEach(() => {
      process.stderr.write = originalStderrWrite;
      process.stdout.write = originalStdoutWrite;
    });

    it("never includes a connection string or any sensitive value", () => {
      log.error("database pool error", {
        MIAOSHOU_APP_SECRET: "postgresql://fixture-user:fixture-pass@127.0.0.1:5432/x",
        PATH: "/usr/bin"
      });
      const written = stderrLines.join("");
      expect(written).toContain("worker: database pool error");
      expect(written).not.toContain("fixture-pass");
      expect(written).not.toContain("fixture-user");
      expect(written).not.toContain("postgresql://");
      expect(written).toContain("\"MIAOSHOU_APP_SECRET\":\"[REDACTED]\"");
    });
  });
});