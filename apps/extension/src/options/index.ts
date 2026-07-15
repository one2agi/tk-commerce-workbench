import { createTokenSettings } from "./token-settings.js";

type ChromeStorage = Parameters<typeof createTokenSettings>[0]["storage"];
const storage = (globalThis as { chrome?: { storage?: ChromeStorage } }).chrome?.storage;

if (storage) {
  const settings = createTokenSettings({ storage });
  const form = document.querySelector("form");
  const input = document.querySelector("input") as HTMLInputElement | null;
  const status = document.querySelector("[data-status]");
  void settings.load().then((token) => {
    if (input && token) input.value = token;
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input) return;
    void settings.save(input.value).then(() => {
      if (status) status.textContent = "已保存";
    });
  });
  document.querySelector("[data-clear]")?.addEventListener("click", () => {
    void settings.clear().then(() => {
      if (input) input.value = "";
      if (status) status.textContent = "已清除";
    });
  });
}
