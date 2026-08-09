import React from "react";
import type { SaveState } from "./settings-api";

export interface SaveBarProps {
  state: SaveState;
  error: string | null;
  dirtyCount: number;
  version: number;
  onDiscard: () => void;
  onSave: () => void;
  autoApply?: boolean;
}

export function SaveBar({ state, error, dirtyCount, version, onDiscard, onSave, autoApply = true }: SaveBarProps): React.JSX.Element | null {
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
          <span>
            已修改 <strong>{dirtyCount}</strong> 项
            <span className="tk-save-bar__meta">当前版本 v{version}</span>
            {autoApply ? <small>保存后由 Worker 自动应用</small> : null}
          </span>
        )}
      </div>
      <div className="tk-save-bar__actions">
        <button type="button" className="tk-save-bar__btn--ghost" onClick={onDiscard} disabled={state === "saving"}>
          放弃更改
        </button>
        <button type="button" className="tk-save-bar__btn--primary" onClick={onSave} disabled={state === "saving"}>
          {state === "saving" ? "正在保存更改…" : "保存更改"}
        </button>
      </div>
    </div>
  );
}
