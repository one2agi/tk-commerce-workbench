import { describe, expect, test } from "vitest";

import type {
  ApprovalState,
  AssetArchiveState,
  AutomationState,
  CanvasState,
  ListingState,
  MiaoshouEditState,
  MiaoshouSourceState
} from "@tk/contracts";

import { projectUiStage, projectStageCounts } from "./project-ui-stage.js";

function base() {
  return {
    miaoshouSource: "success" as MiaoshouSourceState,
    automation: "not_started" as AutomationState,
    assetArchive: "pending" as AssetArchiveState,
    listing: "pending" as ListingState,
    canvas: "not_started" as CanvasState,
    approval: "unapproved" as ApprovalState,
    miaoshouEdit: "not_started" as MiaoshouEditState
  };
}

describe("projectUiStage", () => {
  test("projects a collected product that has not started automation as pending", () => {
    expect(projectUiStage(base()).label).toBe("pending");
  });

  test("projects active source, automation, and edit work as processing", () => {
    expect(projectUiStage({ ...base(), automation: "running" }).label).toBe("processing");
    expect(projectUiStage({ ...base(), miaoshouSource: "pending" }).label).toBe("processing");
    expect(projectUiStage({ ...base(), approval: "approved", miaoshouEdit: "queued" }).label).toBe("processing");
  });

  test("projects a complete draft waiting for approval as review", () => {
    const stage = projectUiStage({
      ...base(),
      automation: "ready",
      assetArchive: "ready",
      listing: "ready",
      canvas: "succeeded"
    });
    expect(stage.label).toBe("review");
  });

  test("projects partial Canvas output as review only when at least one output is usable", () => {
    const draft = {
      ...base(),
      automation: "ready" as const,
      assetArchive: "ready" as const,
      listing: "ready" as const,
      canvas: "partial" as const
    };
    expect(projectUiStage({ ...draft, hasUsableCanvasOutputs: true }).label).toBe("review");
    expect(projectUiStage({ ...draft, hasUsableCanvasOutputs: false }).label).toBe("needs_attention");
  });

  test("projects failed, needs-input, unknown, and invalidated work as needs attention", () => {
    expect(projectUiStage({ ...base(), assetArchive: "failed" }).label).toBe("needs_attention");
    expect(projectUiStage({ ...base(), automation: "needs_input" }).label).toBe("needs_attention");
    expect(projectUiStage({ ...base(), miaoshouEdit: "result_unknown" }).label).toBe("needs_attention");
    expect(projectUiStage({ ...base(), approval: "invalidated" }).label).toBe("needs_attention");
  });

  test("projects a successful Miaoshou edit as synced", () => {
    expect(projectUiStage({ ...base(), approval: "approved", miaoshouEdit: "succeeded" }).label).toBe("synced");
  });
});

describe("projectStageCounts", () => {
  test("counts every product in exactly one product-facing stage", () => {
    const rows = [
      base(),
      { ...base(), automation: "running" as const },
      {
        ...base(),
        automation: "ready" as const,
        assetArchive: "ready" as const,
        listing: "ready" as const,
        canvas: "succeeded" as const
      },
      { ...base(), automation: "needs_input" as const },
      { ...base(), approval: "approved" as const, miaoshouEdit: "succeeded" as const }
    ];
    expect(projectStageCounts(rows)).toEqual({
      pending: 1,
      processing: 1,
      review: 1,
      needsAttention: 1,
      synced: 1
    });
  });
});
