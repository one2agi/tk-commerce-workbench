export const BASIC_BCP47_PATTERN_SOURCE = "[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*";
export const BASIC_BCP47_PATTERN = new RegExp(`^${BASIC_BCP47_PATTERN_SOURCE}$`);

export function isBasicBcp47(value: string): boolean {
  return BASIC_BCP47_PATTERN.test(value);
}
