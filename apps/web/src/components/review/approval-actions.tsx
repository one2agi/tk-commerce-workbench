"use client";

import { useRef, useState } from "react";
import type { ConfirmMiaoshouEditV1, RerunDownstreamV1, UpdateProductOverridesV1 } from "@tk/contracts";
import { BASIC_BCP47_PATTERN_SOURCE, isBasicBcp47 } from "../../lib/locale";

type ActionResult = Record<string, unknown> & { draftVersion?: number; revisionId?: string };
type VersionedDraftUpdate = UpdateProductOverridesV1 & Readonly<{ expectedDraftVersion: number }>;
export type ReviewActions = Readonly<{
  updateDraft(command: VersionedDraftUpdate): Promise<ActionResult>;
  rerun(command: RerunDownstreamV1): Promise<ActionResult>;
  confirm(command: ConfirmMiaoshouEditV1): Promise<ActionResult>;
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
    expectedPricingRunId: command.expectedPricingRunId,
    expectedTemplateVersion: command.expectedTemplateVersion,
    orderedFinalAssetIds: command.orderedFinalAssetIds
  })
};

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
  pricingRunId: string;
  templateVersion: number;
  orderedFinalAssetIds: string[];
  targetLocale: string;
  translationStyle: string;
  actions?: ReviewActions;
}>) {
  const [locale, setLocale] = useState(props.targetLocale);
  const [style, setStyle] = useState(props.translationStyle);
  const [startNode, setStartNode] = useState<RerunDownstreamV1["startNode"]>("listing");
  const [draftVersion, setDraftVersion] = useState(props.draftVersion);
  const [revisionId, setRevisionId] = useState(props.revisionId);
  const [approvalInvalidated, setApprovalInvalidated] = useState(false);
  const [status, setStatus] = useState("待确认");
  const confirmInFlight = useRef(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const actions = props.actions ?? {
    ...defaultActions,
    rerun: (command: RerunDownstreamV1) => request(`/api/v1/products/${props.productId}/rerun`, "POST", command)
  };

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
        expectedPricingRunId: props.pricingRunId,
        expectedTemplateVersion: props.templateVersion,
        orderedFinalAssetIds: props.orderedFinalAssetIds
      });
      setApprovalInvalidated(false);
      setStatus("已进入妙手同步队列");
    } catch {
      setStatus("确认失败，请刷新版本后重试");
    } finally {
      confirmInFlight.current = false;
      setConfirmPending(false);
    }
  }

  return (
    <section aria-label="审核操作" className="tk-panel tk-review__actions">
      <header><h2>审核与同步</h2><span role="status" aria-live="polite">{approvalInvalidated ? "审批状态：已失效，需重新确认" : `审批状态：${status}`}</span></header>
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
        <label>从节点重跑
          <select value={startNode} onChange={(event) => setStartNode(event.target.value as RerunDownstreamV1["startNode"])}>
            <option value="listing">Listing</option>
            <option value="pricing">定价</option>
            <option value="template">模板匹配</option>
            <option value="canvas">Canvas 生图</option>
          </select>
        </label>
        <button type="button" onClick={() => void rerun()}>开始局部重跑</button>
        <button type="button" disabled={confirmPending || props.orderedFinalAssetIds.length === 0 || !props.listingRunId || !props.pricingRunId} onClick={() => void confirm()}>
          确认并推送妙手
        </button>
      </div>
      <p>确认只会编辑妙手中已采集的同一商品，不会触发店铺发布。</p>
    </section>
  );
}
