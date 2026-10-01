"use client";

import { useMemo, useState, type ReactElement } from "react";
import type { GenerationAuditRecordV1, MiaoshouSyncStatusV1, WriteRecordsOverviewV1 } from "@tk/contracts/read-models";

import { WriteRecordsBento, type BentoMetrics } from "./write-records-bento";
import { SyncRecordsTable } from "./sync-records-table";
import { GenerationRecordsTable } from "./generation-records-table";

export function WriteRecordsWorkspace({
  data
}: {
  data: WriteRecordsOverviewV1;
}): ReactElement {
  const [activeTab, setActiveTab] = useState<"sync" | "generation">("sync");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const metrics: BentoMetrics = data.metrics ?? {
    todayCollected: data.items.length,
    todayWritten: data.items.length,
    todaySuccess: data.items.filter((i) => i.state === "succeeded").length,
    todayFailed: data.items.filter((i) => i.state === "failed").length,
    todayImages: data.items.filter((i) => i.state === "succeeded").length * 5
  };

  const filteredSyncItems = useMemo(() => {
    return data.items.filter((item) => {
      if (statusFilter !== "all" && item.state !== statusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const titleMatch = (item.title ?? "").toLowerCase().includes(query);
        const syncIdMatch = item.syncId.toLowerCase().includes(query);
        const detailIdMatch = (item.remoteDetailId ?? "").toLowerCase().includes(query);
        const productIdMatch = (item.productId ?? "").toLowerCase().includes(query);
        if (!titleMatch && !syncIdMatch && !detailIdMatch && !productIdMatch) {
          return false;
        }
      }
      return true;
    });
  }, [data.items, statusFilter, searchQuery]);

  const filteredGenItems = useMemo(() => {
    const list = data.generationRecords ?? [];
    return list.filter((item) => {
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const titleMatch = item.title.toLowerCase().includes(query);
        const batchMatch = item.batchId.toLowerCase().includes(query);
        if (!titleMatch && !batchMatch) {
          return false;
        }
      }
      return true;
    });
  }, [data.generationRecords, searchQuery]);

  const hasActiveFilters = searchQuery.trim().length > 0 || statusFilter !== "all";

  return (
    <div className="tk-write-records-page">
      {/* 1. Header with Taste Soft Eyebrow Tag */}
      <header style={{ marginBottom: "20px" }}>
        <span className="tk-write-records-eyebrow">
          MIAOSHOU ERP · SYNC & GENERATION LEDGER
        </span>
        <h1 className="tk-write-records-title">
          写入记录与算力流水
        </h1>
        <p className="tk-write-records-desc">
          这里展示确认后写回妙手 canonical 公共采集箱商品的记录，不展示 TikTok 发布入口。支持查看 AI 电商营销生图算力流水与出图审计。
        </p>
      </header>

      {/* 2. Top Bento Cards */}
      <WriteRecordsBento metrics={metrics} />

      {/* 3. Main Double-Bezel Card */}
      <div className="tk-write-records-main-card">
        <div className="tk-write-records-main-card__inner">
          {/* Controls Bar: Tabs & Search / Filter */}
          <div className="tk-write-records-controls">
            {/* Tabs */}
            <div className="tk-write-records-tabs">
              <button
                type="button"
                onClick={() => setActiveTab("sync")}
                className={`tk-write-records-tab-btn ${activeTab === "sync" ? "is-active" : ""}`}
              >
                写入记录 ({data.items.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("generation")}
                className={`tk-write-records-tab-btn ${activeTab === "generation" ? "is-active" : ""}`}
              >
                生成记录 ({data.generationRecords?.length ?? 0})
              </button>
            </div>

            {/* Filter Tools */}
            <div className="tk-write-records-filter-group">
              <div className="tk-write-records-search-box">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索商品名称 / ID..."
                  className="tk-write-records-search-input"
                />
                <span className="tk-write-records-search-icon" aria-hidden="true">
                  🔍
                </span>
              </div>

              {activeTab === "sync" && (
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="tk-write-records-select"
                >
                  <option value="all">全部状态</option>
                  <option value="succeeded">已写入 (succeeded)</option>
                  <option value="syncing">正在写入 (syncing)</option>
                  <option value="queued">排队中 (queued)</option>
                  <option value="failed">写入受阻 (failed)</option>
                </select>
              )}

              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("all");
                  }}
                  className="tk-write-records-reset-btn"
                >
                  重置
                </button>
              )}
            </div>
          </div>

          {/* Active Table */}
          <div style={{ marginTop: "14px" }}>
            {activeTab === "sync" ? (
              <SyncRecordsTable items={filteredSyncItems} />
            ) : (
              <GenerationRecordsTable items={filteredGenItems} />
            )}
          </div>

          {/* Footer Metadata */}
          <div className="tk-write-records-footer">
            <div>
              <span>显示 {activeTab === "sync" ? filteredSyncItems.length : filteredGenItems.length} 条记录</span>
              {hasActiveFilters && <span style={{ marginLeft: "4px", color: "#71717a" }}>(已应用筛选)</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span>通道: 妙手 OpenAPI (Canonical)</span>
              <span>·</span>
              <span>状态: 正常运行</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
