import { describe, it, expect } from "vitest";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "./loopback";

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

describe("rejectUnsafeBrowserMutation loopback alias", () => {
  it("accepts Docker's unspecified bind URL when the original host is loopback", () => {
    const request = makeRequest("http://0.0.0.0:3000/api/v1/settings", {
      host: "127.0.0.1:3000",
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000"
    });
    expect(rejectNonLoopback(request)).toBeNull();
    expect(rejectUnsafeBrowserMutation(request)).toBeNull();
  });

  it("rejects Docker's unspecified bind URL when the original host is remote", () => {
    const request = makeRequest("http://0.0.0.0:3000/api/v1/settings", {
      host: "192.168.1.8:3000"
    });
    expect(rejectNonLoopback(request)?.status).toBe(403);
  });

  it("accepts 127.0.0.1 origin against localhost request URL", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000"
    });
    expect(rejectUnsafeBrowserMutation(req)).toBeNull();
  });

  it("accepts localhost origin against 127.0.0.1 request URL", () => {
    const req = makeRequest("http://127.0.0.1:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://localhost:3000"
    });
    expect(rejectUnsafeBrowserMutation(req)).toBeNull();
  });

  it("accepts ::1 origin against 127.0.0.1 request URL", () => {
    const req = makeRequest("http://127.0.0.1:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://[::1]:3000"
    });
    expect(rejectUnsafeBrowserMutation(req)).toBeNull();
  });

  it("rejects different port even on same loopback alias", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3100"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects different scheme", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "https://localhost:3000"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects non-loopback origin", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://evil.com"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("preserves existing behavior: missing Origin rejected", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("preserves existing behavior: wrong Content-Type rejected", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "text/plain",
      origin: "http://localhost:3000"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
