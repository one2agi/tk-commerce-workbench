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
      accent: ""
    },
    {
      label: "今日写入",
      value: metrics.todayWritten,
      unit: "件",
      hint: "已推送至妙手采集箱",
      accent: ""
    },
    {
      label: "今日成功",
      value: metrics.todaySuccess,
      unit: "件",
      hint: "妙手草稿箱刊登就绪",
      accent: "is-success"
    },
    {
      label: "今日失败",
      value: metrics.todayFailed,
      unit: "件",
      hint: metrics.todayFailed === 0 ? "零拦截 · 刊登校验全过" : "校验或接口异常待排查",
      accent: metrics.todayFailed === 0 ? "" : "is-error"
    },
    {
      label: "今日生图",
      value: metrics.todayImages,
      unit: "张",
      hint: "AI 清洗电商营销成图",
      accent: "is-ai"
    }
  ];

  return (
    <div className="tk-write-records-bento">
      {cards.map((card) => (
        <div key={card.label} className="tk-write-records-bento-card">
          <div className="tk-write-records-bento-card__inner">
            <div className="tk-write-records-bento-card__label">
              <span>{card.label}</span>
              <span className="tk-write-records-bento-card__dot" aria-hidden="true" />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "2px" }}>
                <span className={`tk-write-records-bento-card__val ${card.accent}`}>
                  {card.value}
                </span>
                <span className="tk-write-records-bento-card__unit">{card.unit}</span>
              </div>
              <p className="tk-write-records-bento-card__hint">{card.hint}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
