import type { FakePorts } from "@tk/contracts/testing";

export const AUTOMATION_DAG = Object.freeze([
  "asset_archive",
  "listing_generate",
  "pricing_calculate",
  "template_match",
  "image_select",
  "canvas_generate",
  "final_preview"
] as const);

export async function importCollectedRevision(input: { revisionId: string; ports: FakePorts }) {
  return { revisionId: input.revisionId, automationState: "not_started" as const };
}
