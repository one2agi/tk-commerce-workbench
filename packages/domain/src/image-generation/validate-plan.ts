export function validatePlannedPrompts(input: {
  requestedCount: number;
  mandatoryFacts: string[];
  prompts: Array<{ slot: number; role: string; prompt: string; mustPreserve: string[]; forbidden: string[] }>;
}) {
  const { requestedCount, mandatoryFacts, prompts } = input;

  // Count check
  if (prompts.length !== requestedCount) {
    throw new Error("image_plan_slots_invalid");
  }

  // Slot contiguity and uniqueness check
  const slots = prompts.map((p) => p.slot);
  const sortedUnique = [...new Set(slots)].sort((a, b) => a - b);
  if (sortedUnique.length !== requestedCount || sortedUnique[0] !== 1 || sortedUnique[sortedUnique.length - 1] !== requestedCount) {
    throw new Error("image_plan_slots_invalid");
  }

  // Duplicate slot check (already covered by Set length, but explicit)
  const slotCount: Record<number, number> = {};
  for (const s of slots) {
    slotCount[s] = (slotCount[s] ?? 0) + 1;
    if (slotCount[s] > 1) throw new Error("image_plan_slots_invalid");
  }

  // Prompt non-empty, length, mandatory fact preservation, forbidden check
  for (const p of prompts) {
    if (!p.prompt || p.prompt.trim().length === 0) throw new Error("image_plan_prompt_empty");
    if (p.prompt.length > 4000) throw new Error("image_plan_prompt_too_long");

    for (const fact of mandatoryFacts) {
      if (!p.mustPreserve.includes(fact) && !p.prompt.includes(fact)) {
        throw new Error("image_plan_fact_missing");
      }
    }

    for (const phrase of p.forbidden) {
      if (p.prompt.includes(phrase)) throw new Error("image_plan_forbidden_phrase");
    }
  }

  return Object.freeze(prompts);
}
