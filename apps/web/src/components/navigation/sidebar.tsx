import Link from "next/link";
import type { ReactElement } from "react";

type SidebarItem = Readonly<{ href: string; label: string; ariaLabel: string }>;

const ITEMS: ReadonlyArray<SidebarItem> = [
  { href: "/", label: "商品", ariaLabel: "商品处理台" },
  { href: "/processing-rules", label: "处理规则", ariaLabel: "处理规则" },
  { href: "/write-records", label: "写入记录", ariaLabel: "妙手写入记录" },
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
