import Link from "next/link";
import type { ReactElement } from "react";

type SidebarItem = Readonly<{ href: string; label: string; ariaLabel: string }>;

const ITEMS: ReadonlyArray<SidebarItem> = [
  { href: "/", label: "商品工作台", ariaLabel: "商品工作台" },
  { href: "/products", label: "商品列表", ariaLabel: "商品列表" },
  { href: "/tasks", label: "任务中心", ariaLabel: "任务中心" },
  { href: "/templates", label: "模板库", ariaLabel: "生图模板库" },
  { href: "/settings", label: "设置", ariaLabel: "工作区设置" }
];

export function Sidebar(): ReactElement {
  return (
    <nav aria-label="主导航" className="tk-sidebar">
      <ul>
        {ITEMS.map((item) => (
          <li key={item.href}>
            <Link href={item.href} aria-label={item.ariaLabel}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
