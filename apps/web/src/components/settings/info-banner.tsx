export function InfoBanner(): React.JSX.Element {
  return (
    <div className="tk-info-banner" role="note">
      <span className="tk-info-banner__icon" aria-hidden>
        ℹ
      </span>
      <div className="tk-info-banner__body">
        <strong>修改这些值只更新工作区默认值。</strong>
        已启动的 Worker 不会被自动重配，需要<strong>重启进程</strong>才能生效。
      </div>
    </div>
  );
}
