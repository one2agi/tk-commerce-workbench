import { describe, expect, it } from "vitest";
import { createFakePorts } from "@tk/contracts/testing";
import { AUTOMATION_DAG, importCollectedRevision } from "./graph.js";

describe("automation graph", () => {
  it("orders work from archive through final preview", () => {
    expect(AUTOMATION_DAG).toEqual([
      "asset_archive",
      "listing_generate",
      "pricing_calculate",
      "template_match",
      "image_select",
      "canvas_generate",
      "final_preview"
    ]);
  });

  it("does not call paid services when a collected revision is merely imported", async () => {
    const ports = createFakePorts();
    const result = await importCollectedRevision({ revisionId: "rev-1", ports });
    expect(result.automationState).toBe("not_started");
    expect(ports.llm.calls).toHaveLength(0);
    expect(ports.exchangeRate.calls).toHaveLength(0);
    expect(ports.canvas.calls).toHaveLength(0);
  });
});
