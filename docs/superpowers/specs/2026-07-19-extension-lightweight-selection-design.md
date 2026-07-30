# Extension Lightweight Selection Design

## Goal

Keep the 1688 browser extension lightweight. The operator manually scans the current page, selects individual products or the full scanned set, and submits only selected products to the local ingest API.

## Problem

The current content script starts a `MutationObserver` on `document.body`. The overlay is also mounted under `body`, and each overlay render mutates its own DOM. On dynamic 1688 pages this can trigger repeated full-page scans and overlay re-renders, making the browser sluggish.

## Design

- Stop automatic whole-body observation on load.
- Add a manual `rescan()` operation that scans the current DOM only when the operator clicks "扫描当前页".
- Add `selectAll()` and `clearSelection()` to support bulk selection without auto-submitting.
- Keep "提交已选" as the only operation that sends data to `http://127.0.0.1:3000/api/v1/ingest-links`.
- Limit the overlay preview list so many scanned products do not create a large floating DOM.
- Preserve paused submission behavior when token or local API is unavailable.

## Non-goals

- No full listing extraction inside the extension.
- No live Miaoshou or Canvas calls from the extension.
- No bypassing 1688 login, captcha, or anti-bot controls.
