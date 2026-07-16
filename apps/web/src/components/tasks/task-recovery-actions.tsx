"use client";

import { useState } from "react";

export function TaskRecoveryActions({ taskId, status, hasRemoteTask }: {
  taskId: string;
  status: string;
  hasRemoteTask?: boolean;
}) {
  const [message, setMessage] = useState("");
  const retryAllowed = ["failed", "needs_input"].includes(status) && !hasRemoteTask;

  async function act(action: "pause" | "resume" | "cancel" | "retry") {
    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      });
      setMessage(response.ok ? "操作已受理" : "当前状态不允许此操作");
    } catch {
      setMessage("网络异常，操作未提交，请重试");
    }
  }

  return <div className="tk-task-actions">
    {status === "queued" && <button type="button" onClick={() => void act("pause")}>暂停</button>}
    {status === "paused" && <button type="button" onClick={() => void act("resume")}>继续</button>}
    {retryAllowed && <button type="button" onClick={() => void act("retry")}>安全重试</button>}
    {["queued", "paused"].includes(status) && <button type="button" onClick={() => void act("cancel")}>取消</button>}
    {hasRemoteTask && <span>已存在远端任务，仅允许对账，不会重复提交</span>}
    <output aria-live="polite">{message}</output>
  </div>;
}
