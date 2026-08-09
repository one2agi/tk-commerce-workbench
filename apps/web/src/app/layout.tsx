import type { ReactNode } from "react";
import { Sidebar } from "../components/navigation/sidebar";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="tk-app">
          <Sidebar />
          <main className="tk-app__main">{children}</main>
        </div>
      </body>
    </html>
  );
}
