"use client";

import { useEffect, useRef, useState } from "react";
import type { ExternalFailureKind } from "@tk/contracts/errors";

export function TaskRecoveryActions({ taskId, status, errorKind }: {
  taskId: string;
  status: string;
  errorKind: ExternalFailureKind | null;
}) {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const requestVersion = useRef(0);
  const context = `${taskId}:${status}:${errorKind ?? "none"}`;
  const contextRef = useRef(context);
  if (contextRef.current !== context) {
    contextRef.current = context;
    requestVersion.current += 1;
    inFlight.current = false;
  }
  useEffect(() => {
    setPending(false);
    setMessage("");
  }, [context]);
  const retryAllowed = ["failed", "needs_input"].includes(status) && errorKind === "retryable";

  async function act(action: "pause" | "resume" | "cancel" | "retry") {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    const version = ++requestVersion.current;
    const requestContext = contextRef.current;
    const isCurrent = () => version === requestVersion.current && requestContext === contextRef.current;
    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      });
      if (isCurrent()) setMessage(response.ok ? "操作已受理" : "当前状态不允许此操作");
    } catch {
      if (isCurrent()) setMessage("网络异常，操作未提交，请重试");
    } finally {
      if (isCurrent()) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  return <div className="tk-task-actions">
    {status === "queued" && <button type="button" disabled={pending} onClick={() => void act("pause")}>暂停</button>}
    {status === "paused" && <button type="button" disabled={pending} onClick={() => void act("resume")}>继续</button>}
    {retryAllowed && <button type="button" disabled={pending} onClick={() => void act("retry")}>安全重试</button>}
    {["queued", "paused"].includes(status) && <button type="button" disabled={pending} onClick={() => void act("cancel")}>取消</button>}
    {errorKind === "reconcile_required" && <span>外部结果未知，仅允许人工对账</span>}
    <output aria-live="polite">{message}</output>
  </div>;
}
