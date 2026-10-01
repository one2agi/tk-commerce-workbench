export default function Loading() {
  return (
    <div className="tk-page-skeleton" aria-busy="true" aria-label="页面加载中">
      <div className="tk-skeleton-block tk-skeleton-header" />
      <div className="tk-skeleton-block tk-skeleton-body" />
    </div>
  );
}
