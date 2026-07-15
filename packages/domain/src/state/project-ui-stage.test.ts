// RED-first test for projecting per-axis states into a UI stage.

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
    miaoshouSource: "not_started" as MiaoshouSourceState,
    automation: "not_started" as AutomationState,
    assetArchive: "pending" as AssetArchiveState,
    listing: "pending" as ListingState,
    canvas: "not_started" as CanvasState,
    approval: "unapproved" as ApprovalState,
    miaoshouEdit: "not_started" as MiaoshouEditState
  };
}

describe("projectUiStage", () => {
  test("not_started is terminal for collection when nothing paid has been invoked", () => {
    const stage = projectUiStage(base());
    expect(stage.label).toBe("not_started");
  });

  test("promotes to collecting once a paid source tool begins", () => {
    const stage = projectUiStage({ ...base(), miaoshouSource: "submitted" });
    expect(stage.label).toBe("collecting");
  });

  test("promotes to approved once approval is approved (independent of edit state)", () => {
    const stage = projectUiStage({
      ...base(),
      assetArchive: "ready",
      listing: "ready",
      canvas: "succeeded",
      approval: "approved",
      miaoshouEdit: "queued"
    });
    expect(stage.label).toBe("approved");
  });

  test("promotes to published once miaoshou edit succeeded", () => {
    const stage = projectUiStage({
      ...base(),
      assetArchive: "ready",
      listing: "ready",
      canvas: "succeeded",
      approval: "approved",
      miaoshouEdit: "succeeded"
    });
    expect(stage.label).toBe("published");
  });

  test("surfaces failed whenever any axis is in a failed/result_unknown terminal state", () => {
    const stage = projectUiStage({
      ...base(),
      assetArchive: "failed"
    });
    expect(stage.label).toBe("blocked");
  });
});

describe("projectStageCounts", () => {
  test("computes per-axis counts without collapsing into one global status", () => {
    const rows = [
      base(),
      { ...base(), miaoshouSource: "success" as const },
      { ...base(), miaoshouSource: "failed" as const },
      { ...base(), assetArchive: "ready" as const }
    ];
    const counts = projectStageCounts(rows);
    expect(counts).toEqual({
      not_started: 1,
      collecting: 1,
      blocked: 1,
      assetReady: 1,
      approved: 0,
      published: 0
    });
  });
});
