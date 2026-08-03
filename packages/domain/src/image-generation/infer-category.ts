// Keyword maps for initial category inference from title + attributes.

const HAT_KEYWORDS = ["帽", "帽子", "草帽", "遮阳帽", "棒球帽", "礼帽", "头饰"];
const JEWELRY_KEYWORDS = ["耳环", "项链", "手链", "戒指", "镯", "首饰", "珍珠", "钻", "宝石"];
const APPAREL_KEYWORDS = ["衬衫", "T恤", "裙子", "裤子", "外套", "上衣", "服装", "棉", "麻", "毛"];

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

export function inferImageCategory(input: { sourceTitle: string; sourceAttributes: Array<{ name: string; value: string }> }): string {
  const { sourceTitle, sourceAttributes } = input;
  const text = [
    sourceTitle,
    ...sourceAttributes.flatMap(({ name, value }) => [name, value])
  ].join(" ");

  if (containsAny(text, HAT_KEYWORDS)) return "women.hat";
  if (containsAny(text, JEWELRY_KEYWORDS)) return "jewelry";
  if (containsAny(text, APPAREL_KEYWORDS)) return "apparel";
  return "generic";
}
