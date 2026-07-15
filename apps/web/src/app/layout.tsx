import type { ReactNode } from "react";
import { Sidebar } from "../components/navigation/sidebar";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th-TH">
      <body>
        <div className="tk-app">
          <Sidebar />
          <main className="tk-app__main">{children}</main>
        </div>
      </body>
    </html>
  );
}