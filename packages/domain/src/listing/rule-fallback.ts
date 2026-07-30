const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const CONTACT = /(?:联系(?:微信|电话|手机)?|微信|威信|vx|v信|手机号|电话)\s*[:：]?\s*[a-zA-Z0-9_-]+/gi;
const WHOLESALE = /(?:厂家直销|一件代发|批发价?|混批|招商加盟)/g;

function dedupeWords(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.filter((word, index) => index === 0 || word !== words[index - 1]).join(" ");
}

export function cleanEvidenceText(value: string): string {
  return dedupeWords(
    value
      .replace(INVISIBLE, "")
      .replace(CONTACT, "")
      .replace(WHOLESALE, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function deterministicListingFallback(input: {
  sourceTitle: string;
  sourceDescription: string;
  sourceAttributes: ReadonlyArray<{ name: string; value: string }>;
  style: string;
  sourceLocale?: string;
  targetLocale?: string;
}) {
  const sourceTitle = cleanEvidenceText(input.sourceTitle);
  const sourceDescription = cleanEvidenceText(input.sourceDescription);
  const targetLocale = input.targetLocale?.toLowerCase() ?? "";
  const sourceLocale = input.sourceLocale?.toLowerCase() ?? "";
  if (targetLocale.startsWith("th") && sourceLocale !== targetLocale) {
    return {
      title: conservativeThaiTitle(sourceTitle, input.sourceAttributes),
      description: conservativeThaiDescription(sourceTitle, sourceDescription, input.sourceAttributes),
      attributes: input.sourceAttributes.map((attribute) => ({
        name: thaiAttributeName(cleanEvidenceText(attribute.name)),
        value: thaiAttributeValue(cleanEvidenceText(attribute.value))
      })),
      styleApplied: input.style,
      provider: "rules" as const,
      model: null,
      degraded: true,
      fallbackUsed: true,
      warningCodes: ["llm_rule_fallback", "cross_locale_rule_fallback"]
    };
  }
  return {
    title: sourceTitle,
    description: sourceDescription,
    attributes: input.sourceAttributes.map((attribute) => ({
      name: cleanEvidenceText(attribute.name),
      value: cleanEvidenceText(attribute.value)
    })),
    styleApplied: input.style,
    provider: "rules" as const,
    model: null,
    degraded: true,
    fallbackUsed: true,
    warningCodes: ["llm_rule_fallback"]
  };
}

function conservativeThaiTitle(sourceTitle: string, attributes: ReadonlyArray<{ name: string; value: string }>): string {
  const evidence = `${sourceTitle} ${attributes.map((item) => `${item.name} ${item.value}`).join(" ")}`;
  const parts: string[] = [];
  if (/T恤|t-?shirt/i.test(evidence)) parts.push("เสื้อยืด");
  if (/项链|สร้อย/i.test(evidence)) parts.push("สร้อยคอ");
  if (/四叶草|โคลเวอร์/i.test(evidence)) parts.push("จี้โคลเวอร์สี่แฉก");
  if (/女|女士|ผู้หญิง/i.test(evidence)) parts.push("สำหรับผู้หญิง");
  if (/棉|纯棉/i.test(evidence)) parts.push("ผ้าฝ้าย");
  if (/钛钢/i.test(evidence)) parts.push("สแตนเลสไทเทเนียม");
  if (/不掉色|ไม่ลอก/i.test(evidence)) parts.push("ไม่ลอกง่าย");
  if (parts.length === 0) return sourceTitle.slice(0, 80);
  return parts.join(" ").slice(0, 120);
}

function conservativeThaiDescription(sourceTitle: string, sourceDescription: string, attributes: ReadonlyArray<{ name: string; value: string }>): string {
  const evidence = `${sourceTitle} ${sourceDescription} ${attributes.map((item) => `${item.name} ${item.value}`).join(" ")}`;
  const parts: string[] = [];
  if (/项链/i.test(evidence)) parts.push("สินค้าเป็นสร้อยคอ");
  if (/钛钢/i.test(evidence)) parts.push("วัสดุสแตนเลสไทเทเนียม");
  if (/不掉色/i.test(evidence)) parts.push("ไม่ลอกง่ายตามข้อมูลสินค้า");
  if (/日常|百搭|夏季/i.test(evidence)) parts.push("เหมาะกับการใส่ในชีวิตประจำวัน");
  return (parts.length > 0 ? parts.join(" ") : sourceDescription).slice(0, 240);
}

function thaiAttributeName(value: string): string {
  const map = new Map([
    ["材质", "วัสดุ"],
    ["风格", "สไตล์"],
    ["颜色", "สี"],
    ["重量", "น้ำหนัก"]
  ]);
  return map.get(value) ?? value;
}

function thaiAttributeValue(value: string): string {
  return value
    .replace(/钛钢/g, "สแตนเลสไทเทเนียม")
    .replace(/ins风/g, "สไตล์มินิมอล");
}
