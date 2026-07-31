export function validateRecipe(input: { inputCount: number; outputCount: number; roles: string[] }) {
  if (
    !Number.isInteger(input.inputCount) ||
    input.inputCount < 1 ||
    input.inputCount > 6 ||
    !Number.isInteger(input.outputCount) ||
    input.outputCount < 1 ||
    input.outputCount > 8
  ) {
    throw new Error("image_generation_count_out_of_range");
  }
  if (input.roles.length < input.outputCount) throw new Error("image_generation_roles_insufficient");
  return Object.freeze({ ...input, roles: input.roles.slice(0, input.outputCount) });
}
