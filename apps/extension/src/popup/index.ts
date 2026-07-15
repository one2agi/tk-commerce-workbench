type ChromeRuntime = { openOptionsPage(): Promise<void> | void };

document.querySelector("button")?.addEventListener("click", () => {
  void (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime?.openOptionsPage();
});
