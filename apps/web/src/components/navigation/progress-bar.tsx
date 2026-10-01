"use client";

import { usePathname } from "next/navigation";
import { type ReactElement, useEffect, useRef, useState } from "react";

export function NavigationProgressBar(): ReactElement {
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(0);

  const prevPathnameRef = useRef(pathname);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearAllTimers = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const startProgress = () => {
    clearAllTimers();
    setActive(true);
    setProgress(20);

    intervalRef.current = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 80) {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          return 80;
        }
        const remaining = 80 - prev;
        const step = Math.max(1, Math.round(remaining * 0.2));
        return Math.min(80, prev + step);
      });
    }, 150);
  };

  const completeProgress = () => {
    clearAllTimers();
    setProgress(100);

    timerRef.current = setTimeout(() => {
      setActive(false);
      timerRef.current = setTimeout(() => {
        setProgress(0);
      }, 250);
    }, 200);
  };

  // 路由变化时快速到达 100% 并在 200ms 后淡出复位
  useEffect(() => {
    if (prevPathnameRef.current !== pathname) {
      prevPathnameRef.current = pathname;
      completeProgress();
    }
  }, [pathname]);

  // 监听导航链接点击
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;

      if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
        return;
      }

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
        return;
      }

      const isTkNav = anchor.getAttribute("data-tk-nav") === "true";
      const isInternal =
        anchor.origin === window.location.origin ||
        (href.startsWith("/") && !href.startsWith("//"));

      if (isTkNav || isInternal) {
        const targetPath = anchor.pathname;
        const currentPath = window.location.pathname;
        if (targetPath === currentPath && anchor.search === window.location.search) {
          return;
        }

        startProgress();
      }
    };

    document.addEventListener("click", handleClick, { capture: true });

    return () => {
      document.removeEventListener("click", handleClick, { capture: true });
      clearAllTimers();
    };
  }, []);

  return (
    <div className="tk-progress-bar" aria-hidden="true">
      <div
        className="tk-progress-bar__fill"
        style={{
          width: `${progress}%`,
          opacity: active ? 1 : 0
        }}
      />
    </div>
  );
}
