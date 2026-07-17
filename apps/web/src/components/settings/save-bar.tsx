import React from "react";
import type { SaveState } from "./settings-api";

export interface SaveBarProps {
  state: SaveState;
  error: string | null;
  dirtyCount: number;
  version: number;
  onDiscard: () => void;
  onSave: () => void;
}

export function SaveBar({ state, error, dirtyCount, version, onDiscard, onSave }: SaveBarProps): React.JSX.Element | null {
  const visible = dirtyCount > 0 || state !== "idle";
  if (!visible) return null;
  const isError = state === "error" || state === "conflict";
  return (
    <div
      className={`tk-save-bar${isError ? " is-error" : ""}`}
      role="region"
      aria-label="保存栏"
    >
      <div className="tk-save-bar__status">
        <span className="dot" aria-hidden />
        {state === "conflict" ? (
          <span>{error ?? "设置已被其他页面更新"}</span>
        ) : state === "error" ? (
          <span>{error ?? "保存失败"}</span>
        ) : (
          <>
            已修改 <strong style={{ color: "var(--primary)", margin: "0 4px" }}>{dirtyCount}</strong> 项
            <span className="tk-save-bar__meta">当前版本 v{version}</span>
          </>
        )}
      </div>
      <div className="tk-save-bar__actions">
        <button type="button" className="tk-save-bar__btn--ghost" onClick={onDiscard} disabled={state === "saving"}>
          放弃修改
        </button>
        <button type="button" className="tk-save-bar__btn--primary" onClick={onSave} disabled={state === "saving"}>
          {state === "saving" ? "保存中…" : "保存设置"}
        </button>
      </div>
    </div>
  );
}
