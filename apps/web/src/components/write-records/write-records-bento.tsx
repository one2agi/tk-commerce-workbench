import type { ReactElement } from "react";

export type BentoMetrics = {
  todayCollected: number;
  todayWritten: number;
  todaySuccess: number;
  todayFailed: number;
  todayImages: number;
};

export function WriteRecordsBento({ metrics }: { metrics: BentoMetrics }): ReactElement {
  const cards = [
    {
      label: "今日采集",
      value: metrics.todayCollected,
      unit: "件",
      hint: "1688 插件抓取入库",
      accent: "text-zinc-900"
    },
    {
      label: "今日写入",
      value: metrics.todayWritten,
      unit: "件",
      hint: "已推送至妙手采集箱",
      accent: "text-zinc-900"
    },
    {
      label: "今日成功",
      value: metrics.todaySuccess,
      unit: "件",
      hint: "妙手草稿箱刊登就绪",
      accent: "text-emerald-600"
    },
    {
      label: "今日失败",
      value: metrics.todayFailed,
      unit: "件",
      hint: metrics.todayFailed === 0 ? "零拦截 · 刊登校验全过" : "校验或接口异常待排查",
      accent: metrics.todayFailed === 0 ? "text-zinc-400" : "text-rose-600"
    },
    {
      label: "今日生图",
      value: metrics.todayImages,
      unit: "张",
      hint: "AI 清洗电商营销成图",
      accent: "text-indigo-600"
    }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3.5 my-6">
      {cards.map((card, i) => (
        <div
          key={card.label}
          className="p-1.5 rounded-[1.75rem] bg-zinc-200/40 border border-black/5 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.03)] transition-all duration-300 hover:shadow-[0_20px_40px_-10px_rgba(0,0,0,0.06)]"
        >
          <div className="rounded-[calc(1.75rem-0.375rem)] bg-white p-4.5 sm:p-5 flex flex-col justify-between h-full min-h-[110px]">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono tracking-[0.18em] text-[11px] uppercase text-zinc-500 font-medium">
                {card.label}
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-300" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-baseline gap-1">
                <span className={`text-3xl sm:text-4xl font-extrabold tracking-tight ${card.accent}`}>
                  {card.value}
                </span>
                <span className="text-xs font-medium text-zinc-400 font-mono">{card.unit}</span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-1 truncate">{card.hint}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
