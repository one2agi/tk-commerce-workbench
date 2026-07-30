# Settings Page Redesign — Progress Ledger

Plan: `docs/superpowers/plans/2026-07-17-settings-page-redesign.md`
Branch: main
Base commit: d236ca0

| Task | Status | Commits | Review |
|------|--------|---------|--------|
| 1 dirty.ts | complete | fb2fd0c | clean |
| 2 field.tsx | complete | 0e9239a | clean |
| 3 settings-card.tsx | complete | a3a2087 | clean |
| 4 status-pill + info-banner | complete | d603f8b | clean |
| 5 five sections | complete | 68b0da6 + 808b9d1 | clean (interaction tests restored) |
| 6 settings-api | complete | 062f5ba | clean (6 tests vs 5 brief, added 5xx test) |
| 7 save-bar | complete | f21315e | clean |
| 8 globals.css | complete | e39bd89 | clean (3 pre-existing @exodus test failures, unrelated) |
| 9 settings-workspace | complete | 8096329 | clean |
| 10 wire page + delete + smoke | complete | 8e94990 + 8b2be5a | clean (final-review test updated) |
| 11 final verification gate | complete | (no commit) | lint/typecheck clean; tests 120 pass / 3 unrelated pre-existing failures |
---

# Start Processing Unblock — Progress Ledger

Plan: `docs/superpowers/plans/2026-07-19-start-processing-unblock.md`
Branch: main
Base commit: 26b5627

| Task | Status | Commits | Review |
|------|--------|---------|--------|
| Task 1: sourceImageCount contract + SQL | complete | 4987cd2 | APPROVED (fixture 衍生改动在 plan 范围内) |
| Task 2: canStartAutomation selector | complete | 4987cd2 | APPROVED_WITH_MINOR → APPROVED via re-review |
| Task 3: ProductTable 行内开始按钮 | complete | 4987cd2 | APPROVED (5 minor findings recorded) |
| Task 4: 商品列表/详情文案 | complete | 4987cd2 | APPROVED_WITH_MINOR → APPROVED via fix re-dispatch (jsdom + CTA 断言修复) |
| Final review | complete | 4987cd2 | READY_FOR_E2E, 0 constraint violations, 0 minorFindings |
| E2E verify | complete | 4987cd2 | passed (4 user-visible changes, 0 blockers) |

---

# Loopback Same-Origin Fix — Progress Ledger

Plan: `docs/superpowers/plans/2026-07-19-loopback-same-origin-fix.md`
Branch: main
Base commit: 4987cd2

| Task | Status | Commits | Review |
|------|--------|---------|--------|
| RED: loopback.test.ts 8 cases | complete | ebeb05a | 3/8 failed as expected (alias tests) |
| GREEN: loopbackAlias + isSameLoopbackOrigin | complete | ebeb05a | 8/8 pass, typecheck pass, live curl 5/5 verified |

---

## Cross-session report
See: `docs/superpowers/reports/2026-07-20-start-processing-unblock-report.md`

---

# Workbench Experience Repair — Pre-development Gate Ledger

Spec: `docs/superpowers/specs/2026-07-21-workbench-experience-repair-spec.md`
Branch: main
Base date: 2026-07-21

| Gate | Status | Evidence | Next action |
|------|--------|----------|-------------|
| Gate 1: freeze MVP repair acceptance target | complete | Product approved success definition: 1688 → workbench → Canvas TK工作流 → title/image repair → edit the same canonical Miaoshou public collect-box item; no TikTok claim or publish | Start Gate 2 audit |
| Gate 2: audit current implementation vs pre-dev spec | complete | Report: `docs/superpowers/reports/2026-07-21-workbench-experience-gate2-audit-report.md`; confirmed UI/productization gaps, settings/runtime split, Canvas 8123 OK, canonical Miaoshou edit path OK | Start Gate 3 state-machine design |
| Gate 3: define business state machine | complete | Product approved automation-first, minimal-button state machine: pending, automatic processing, review, syncing to Miaoshou, done, needs human action | Start Gate 4 information architecture |
| Gate 4: redesign workbench information architecture | complete | Product confirmed final nav: Product, Processing Rules, Write Records, Settings; Task Center removed from main nav and moved to Settings → System Diagnostics / Task Logs; table fields, state tabs, batch actions, detail layout, settings boundary, and exception recovery rules frozen in spec | Start Gate 5 fixed acceptance product set |
| Gate 5: prepare fixed acceptance product set | complete | Product approved current sample set: two single-product URLs and one 1688 search batch page; multi-SKU covered by current samples; image-insufficient and exception cases covered by synthetic fixtures | Start Gate 6 implementation plan |
| Gate 6: implement workbench experience repair | complete | Plan saved at `docs/superpowers/plans/2026-07-22-workbench-experience-repair.md`; focused Web tests 64 pass; settings tests 18 pass; `pnpm lint`, `pnpm typecheck`, `pnpm build` pass; Playwright target E2E 3 pass with `tk_workbench_test`; verification report saved at `docs/superpowers/reports/2026-07-22-workbench-experience-repair-verification.md` | Proceed to manual live acceptance with extension + Canvas 8123 + Miaoshou |
