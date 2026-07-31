export function imageSlotBusinessKey(input: {
  revisionId: string;
  templateVersionId: string;
  slot: number;
  promptHash: string;
}): string {
  return `${input.revisionId}:${input.templateVersionId}:${input.slot}:${input.promptHash}`;
}
