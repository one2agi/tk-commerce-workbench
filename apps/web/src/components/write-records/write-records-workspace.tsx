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
    <div className="max-w-[1240px] mx-auto py-8 px-4 sm:px-6">
      {/* 1. Header with Taste Soft Eyebrow Tag */}
      <header className="mb-6">
        <span className="font-mono tracking-[0.2em] text-[10px] uppercase text-zinc-500 bg-zinc-200/60 rounded-full px-2.5 py-0.5 inline-block mb-3">
          MIAOSHOU ERP · SYNC & GENERATION LEDGER
        </span>
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-zinc-900">
          写入记录与算力流水
        </h1>
        <p className="mt-2 text-sm text-zinc-500 max-w-[65ch] leading-relaxed">
          这里展示确认后写回妙手 canonical 公共采集箱商品的记录，不展示 TikTok 发布入口。支持查看 AI 电商营销生图算力流水与出图审计。
        </p>
      </header>

      {/* 2. Top Bento Cards */}
      <WriteRecordsBento metrics={metrics} />

      {/* 3. Main Double-Bezel Card */}
      <div className="p-1.5 rounded-[2rem] bg-zinc-200/40 border border-black/5 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.03)] my-6">
        <div className="rounded-[calc(2rem-0.375rem)] bg-white p-5 sm:p-6">
          {/* Controls Bar: Tabs & Search / Filter */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-black/5">
            {/* Tabs */}
            <div className="flex items-center gap-1.5 p-1 bg-zinc-100 rounded-full w-fit">
              <button
                type="button"
                onClick={() => setActiveTab("sync")}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 ${
                  activeTab === "sync"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                写入记录 ({data.items.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("generation")}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 ${
                  activeTab === "generation"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                生成记录 ({data.generationRecords?.length ?? 0})
              </button>
            </div>

            {/* Filter Tools */}
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索商品名称 / ID..."
                  className="pl-8 pr-3 py-1.5 text-xs rounded-full bg-zinc-100 border-none focus:ring-2 focus:ring-zinc-900 text-zinc-800 placeholder-zinc-400 w-[180px] sm:w-[220px]"
                />
                <span className="absolute left-2.5 top-2 text-zinc-400 text-xs pointer-events-none" aria-hidden="true">
                  🔍
                </span>
              </div>

              {activeTab === "sync" && (
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="text-xs rounded-full bg-zinc-100 border-none px-3 py-1.5 text-zinc-700 font-medium focus:ring-2 focus:ring-zinc-900 cursor-pointer"
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
                  className="text-xs text-zinc-400 hover:text-zinc-700 px-2 py-1 transition-colors"
                >
                  重置
                </button>
              )}
            </div>
          </div>

          {/* Active Table */}
          <div className="mt-4">
            {activeTab === "sync" ? (
              <SyncRecordsTable items={filteredSyncItems} />
            ) : (
              <GenerationRecordsTable items={filteredGenItems} />
            )}
          </div>

          {/* Footer Metadata */}
          <div className="mt-6 pt-4 border-t border-black/5 flex flex-col sm:flex-row items-center justify-between text-xs text-zinc-400 font-mono gap-2">
            <div>
              <span>显示 {activeTab === "sync" ? filteredSyncItems.length : filteredGenItems.length} 条记录</span>
              {hasActiveFilters && <span className="ml-1 text-zinc-500">(已应用筛选)</span>}
            </div>
            <div className="flex items-center gap-3">
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
