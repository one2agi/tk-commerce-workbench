export function renderProcessingRulesPage() {
  return (
    <section aria-label="处理规则">
      <header className="tk-page-heading">
        <div>
          <p>Rules</p>
          <h1>处理规则</h1>
        </div>
      </header>

      <div className="tk-panel">
        <h2>标题规则</h2>
        <p>
          用于控制标题清洗、目标语言风格、禁词和保留词。商品属性以妙手采集结果为准，
          本地只做翻译、清洗、格式校验和缺失提示。
        </p>
        <dl>
          <div>
            <dt>默认目标语言</dt>
            <dd>th-TH，可在设置页改为自定义 BCP-47 语言代码。</dd>
          </div>
          <div>
            <dt>标题风格</dt>
            <dd>电商转化、简洁、高端。</dd>
          </div>
          <div>
            <dt>禁词 / 保留词</dt>
            <dd>本期先展示规则说明，持久化编辑放入后续增强。</dd>
          </div>
        </dl>
      </div>

      <div className="tk-panel">
        <h2>Canvas 工作流</h2>
        <p>
          当前绑定 Canvas 画布 TK 的 <code>TK工作流</code>：最多输入 9 张图，期望输出 5 张图。
          产品识别和图片生成策略由 Canvas 工作流内部处理。
        </p>
      </div>
    </section>
  );
}

export default function ProcessingRulesPage() {
  return renderProcessingRulesPage();
}
