"use client";

import { useRef, useState } from "react";
import type { ConfirmMiaoshouEditV1, RerunDownstreamV1, UpdateProductOverridesV1 } from "@tk/contracts";
import type { ApprovalPreviewV1 } from "@tk/contracts/read-models";
import { BASIC_BCP47_PATTERN_SOURCE, isBasicBcp47 } from "../../lib/locale";
import { IconCheck, IconRefresh, IconArrowRight } from "./review-icons";

type ActionResult = Record<string, unknown> & { draftVersion?: number; revisionId?: string };
type VersionedDraftUpdate = UpdateProductOverridesV1 & Readonly<{ expectedDraftVersion: number }>;
export type ReviewActions = Readonly<{
  updateDraft(command: VersionedDraftUpdate): Promise<ActionResult>;
  rerun(command: RerunDownstreamV1): Promise<ActionResult>;
  confirm(command: ConfirmMiaoshouEditV1): Promise<ActionResult>;
  retryMiaoshouEdit(productId: string): Promise<ActionResult>;
}>;

const defaultActions: ReviewActions = {
  updateDraft: (command) => request(`/api/v1/products/${command.productId}/draft`, "PATCH", {
    version: command.version,
    expectedDraftVersion: command.expectedDraftVersion,
    targetLocale: command.targetLocale,
    translationStyle: command.translationStyle
  }),
  rerun: () => Promise.reject(new Error("product_scoped_rerun_action_required")),
  confirm: (command) => request(`/api/v1/products/${command.productId}/confirm-miaoshou-edit`, "POST", {
    version: command.version,
    expectedDraftVersion: command.expectedDraftVersion,
    expectedListingRunId: command.expectedListingRunId,
    expectedTemplateVersion: command.expectedTemplateVersion,
    orderedFinalAssetIds: command.orderedFinalAssetIds
  }),
  retryMiaoshouEdit: (productId) => request(`/api/v1/products/${productId}/retry-miaoshou-edit`, "POST", {})
};

const DEFAULT_WRITEBACK: ApprovalPreviewV1["miaoshouWriteback"] = {
  state: "not_started",
  failureCode: null,
  safeMessage: null,
  retryAllowed: false,
  approvalSnapshotId: null
};

function writebackStatus(view: ApprovalPreviewV1["miaoshouWriteback"]): string {
  switch (view.state) {
    case "queued":
    case "syncing":
      return "正在写回妙手";
    case "succeeded":
      return "已写回妙手";
    case "failed":
      return "妙手写回失败";
    case "result_unknown":
      return view.failureCode === "miaoshou_reconcile_no_change" || view.retryAllowed
        ? "妙手写回未生效，远端仍为原内容"
        : "妙手写回结果未知，需要人工核对";
    default:
      return "待确认";
  }
}

async function request(url: string, method: string, body: unknown): Promise<ActionResult> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as ActionResult;
  if (!response.ok) throw new Error(String(result.error ?? "request_failed"));
  return result;
}

export function buildDraftUpdateCommand(input: Readonly<{
  productId: string;
  draftVersion: number;
  targetLocale: string;
  translationStyle: string;
}>): VersionedDraftUpdate {
  if (!isBasicBcp47(input.targetLocale)) throw new Error("invalid_target_locale");
  return {
    version: 1,
    productId: input.productId,
    expectedDraftVersion: input.draftVersion,
    targetLocale: input.targetLocale,
    translationStyle: input.translationStyle
  };
}

export function ApprovalActions(props: Readonly<{
  productId: string;
  revisionId: string;
  draftVersion: number;
  listingRunId: string;
  templateVersion: number;
  orderedFinalAssetIds: string[];
  canonicalMiaoshouTarget?: string | null;
  firstFinalImageUrl?: string | null;
  targetLocale: string;
  translationStyle: string;
  miaoshouWriteback?: ApprovalPreviewV1["miaoshouWriteback"];
  actions?: ReviewActions;
}>) {
  const initialWriteback = props.miaoshouWriteback ?? DEFAULT_WRITEBACK;
  const [locale, setLocale] = useState(props.targetLocale);
  const [style, setStyle] = useState(props.translationStyle);
  const [startNode, setStartNode] = useState<RerunDownstreamV1["startNode"]>("listing");
  const [draftVersion, setDraftVersion] = useState(props.draftVersion);
  const [revisionId, setRevisionId] = useState(props.revisionId);
  const [approvalInvalidated, setApprovalInvalidated] = useState(false);
  const [writebackState, setWritebackState] = useState(initialWriteback.state);
  const [status, setStatus] = useState(writebackStatus(initialWriteback));
  const confirmInFlight = useRef(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const retryInFlight = useRef(false);
  const [retryPending, setRetryPending] = useState(false);
  const actions = props.actions ?? {
    ...defaultActions,
    rerun: (command: RerunDownstreamV1) => request(`/api/v1/products/${props.productId}/rerun`, "POST", command)
  };
  const confirmationBlockers = [
    ...(props.orderedFinalAssetIds.length === 0 ? ["请先确认最终图片"] : []),
    ...(!props.listingRunId ? ["商品文案尚未生成完成"] : []),
    ...(approvalInvalidated ? ["草稿已变化，请重新审核"] : [])
  ];

  async function saveDraft() {
    let command: VersionedDraftUpdate;
    try {
      command = buildDraftUpdateCommand({
        productId: props.productId,
        draftVersion,
        targetLocale: locale,
        translationStyle: style
      });
    } catch {
      setStatus("语言代码格式无效");
      return;
    }
    setStatus("正在保存草稿…");
    try {
      const result = await actions.updateDraft(command);
      if (typeof result.draftVersion === "number") setDraftVersion(result.draftVersion);
      if (typeof result.revisionId === "string") setRevisionId(result.revisionId);
      setApprovalInvalidated(true);
      setStatus("草稿已保存");
    } catch {
      setStatus("草稿保存失败");
    }
  }

  async function rerun() {
    setStatus("正在提交局部重跑…");
    try {
      const result = await actions.rerun({ version: 1, revisionId, expectedDraftVersion: draftVersion, startNode });
      if (typeof result.draftVersion === "number") setDraftVersion(result.draftVersion);
      if (typeof result.revisionId === "string") setRevisionId(result.revisionId);
      setApprovalInvalidated(true);
      setStatus("局部重跑已排队");
    } catch {
      setStatus("局部重跑提交失败");
    }
  }

  async function confirm() {
    if (confirmInFlight.current) return;
    confirmInFlight.current = true;
    setConfirmPending(true);
    setStatus("正在创建不可变审批快照…");
    try {
      await actions.confirm({
        version: 1,
        productId: props.productId,
        expectedDraftVersion: draftVersion,
        expectedListingRunId: props.listingRunId,
        expectedTemplateVersion: props.templateVersion,
        orderedFinalAssetIds: props.orderedFinalAssetIds
      });
      setApprovalInvalidated(false);
      setWritebackState("queued");
      setStatus("已进入妙手同步队列");
    } catch {
      setStatus("确认失败，请刷新版本后重试");
    } finally {
      confirmInFlight.current = false;
      setConfirmPending(false);
    }
  }

  async function retryMiaoshouEdit() {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetryPending(true);
    setStatus("正在提交妙手人工重试…");
    try {
      await actions.retryMiaoshouEdit(props.productId);
      setWritebackState("queued");
      setStatus("已进入妙手同步队列");
    } catch (error) {
      const code = error instanceof Error ? error.message : "miaoshou_retry_failed";
      setStatus(code === "revision_changed"
        ? "商品版本已变化，请重新审核后确认"
        : code === "writeback_in_progress"
          ? "妙手写回任务已在处理中"
          : "重新写回失败，请刷新后重试");
    } finally {
      retryInFlight.current = false;
      setRetryPending(false);
    }
  }

  return (
    <section aria-label="审核操作" className="tk-panel tk-review__actions">
      <header><h2>审核与同步</h2><span role="status" aria-live="polite">{approvalInvalidated ? "审批状态：已失效，需重新确认" : `审批状态：${status}`}</span></header>
      <div className="tk-review__writeback-summary">
        {props.firstFinalImageUrl ? <img src={props.firstFinalImageUrl} alt="写回主图预览" /> : <div className="tk-review__writeback-placeholder">暂无主图</div>}
        <dl>
          <div><dt>妙手目标</dt><dd>{props.canonicalMiaoshouTarget ?? "待系统匹配"}</dd></div>
          <div><dt>最终图片</dt><dd>{props.orderedFinalAssetIds.length} 张</dd></div>
          <div><dt>同步状态</dt><dd>{writebackStatus({ ...initialWriteback, state: writebackState })}</dd></div>
        </dl>
      </div>
      <div className="tk-review__writeback-actions">
        {writebackState === "not_started" && <button
          type="button"
          className="tk-review__primary-action"
          disabled={confirmPending || confirmationBlockers.length > 0}
          onClick={() => void confirm()}
        >确认并写回妙手</button>}
        {(writebackState === "result_unknown" || writebackState === "failed") && initialWriteback.retryAllowed && !approvalInvalidated && <button
          type="button"
          className="tk-review__primary-action"
          disabled={retryPending}
          onClick={() => void retryMiaoshouEdit()}
        >重新写回妙手</button>}
        {(writebackState === "queued" || writebackState === "syncing") && <button type="button" className="tk-review__primary-action" disabled>正在写回妙手</button>}
        {confirmationBlockers.length > 0 && writebackState === "not_started" ? (
          <ul className="tk-review__writeback-blockers">{confirmationBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        ) : null}
        {writebackState === "failed" ? <p className="tk-review__writeback-warning">写回失败，但已确认图片和审核结果仍保留；重新写回不会重新洗图。</p> : null}
        <p>进入队列后系统才开始同步；这里只更新妙手采集箱草稿，不会发布到店铺。</p>
      </div>

      {/* 底部悬浮操作岛 Floating Action Island */}
      <div className="tk-floating-island" role="toolbar" aria-label="快捷审核与放行">
        <div className="tk-floating-island__status">
          <span className={`tk-floating-island__dot ${writebackState === "succeeded" ? "is-succeeded" : "is-active"}`} />
          <span className="tk-floating-island__text">
            {writebackState === "succeeded"
              ? "已成功写回妙手采集箱"
              : writebackState === "queued" || writebackState === "syncing"
                ? "正在向妙手同步中…"
                : confirmationBlockers.length > 0
                  ? "当前有前置检查项未就绪，需完成确认"
                  : "5 张营销主图已就绪 · 规格已自动校验通过"}
          </span>
        </div>
        <div className="tk-floating-island__actions">
          {writebackState === "not_started" && (
            <button
              type="button"
              className="tk-floating-island__btn-confirm"
              disabled={confirmPending || confirmationBlockers.length > 0}
              onClick={() => void confirm()}
            >
              <IconCheck />
              <span>确认放行 · 写入妙手</span>
            </button>
          )}
          {(writebackState === "result_unknown" || writebackState === "failed") && initialWriteback.retryAllowed && !approvalInvalidated && (
            <button
              type="button"
              className="tk-floating-island__btn-confirm"
              disabled={retryPending}
              onClick={() => void retryMiaoshouEdit()}
            >
              <IconRefresh />
              <span>重试写入妙手</span>
            </button>
          )}
          {(writebackState === "queued" || writebackState === "syncing") && (
            <button type="button" className="tk-floating-island__btn-confirm is-syncing" disabled>
              <span>妙手同步处理中…</span>
            </button>
          )}
          {writebackState === "succeeded" && (
            <a href={`/write-records?productId=${encodeURIComponent(props.productId)}`} className="tk-floating-island__btn-link">
              <span>查看写回记录</span>
              <IconArrowRight />
            </a>
          )}
        </div>
      </div>

      <details className="tk-review__advanced-actions">
        <summary>高级恢复与生成设置</summary>
        <div className="tk-form-row">
          <label>目标语言
            <input
              value={locale}
              onChange={(event) => setLocale(event.target.value)}
              list="recommended-locales"
              pattern={BASIC_BCP47_PATTERN_SOURCE}
              placeholder="例如 ms-MY"
              aria-describedby="locale-format-help"
            />
            <datalist id="recommended-locales">
              <option value="th-TH">泰语（泰国）</option>
              <option value="en-US">英语（美国）</option>
              <option value="vi-VN">越南语</option>
              <option value="id-ID">印度尼西亚语</option>
            </datalist>
            <small id="locale-format-help">支持任意合法 BCP-47 语言代码</small>
          </label>
          <label>翻译风格
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              <option value="marketplace">电商转化</option>
              <option value="concise">简洁</option>
              <option value="premium">高端</option>
            </select>
          </label>
          <button type="button" onClick={() => void saveDraft()}>保存草稿设置</button>
        </div>
        <div className="tk-form-row">
          <label>恢复起点
            <select value={startNode} onChange={(event) => setStartNode(event.target.value as RerunDownstreamV1["startNode"])}>
              <option value="listing">从商品文案环节重跑</option>
              <option value="template">从模板匹配环节重跑</option>
              <option value="canvas">从洗图环节重跑</option>
            </select>
          </label>
          <button type="button" onClick={() => void rerun()}>提交恢复任务</button>
        </div>
      </details>
    </section>
  );
}
