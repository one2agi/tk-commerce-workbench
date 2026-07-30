import { externalFailure, type ApprovalSnapshotV1 } from "@tk/contracts";

export type MiaoshouEditableDetail = Readonly<{
  title: string;
  notesText: string;
  notes: string;
  imgUrls: readonly string[];
  sourceAttrs: ReadonlyArray<Readonly<{ name: string; value: string }>>;
}>;

function remoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function miaoshouText(value: string, maxLength = 255): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export function mapApprovalSnapshotToMiaoshouEdit(
  snapshot: ApprovalSnapshotV1,
  orderedRemoteAssetUrls: string[]
): MiaoshouEditableDetail {
  if (
    orderedRemoteAssetUrls.length !== snapshot.orderedFinalAssetIds.length
    || orderedRemoteAssetUrls.some((url) => !remoteUrl(url))
    || new Set(orderedRemoteAssetUrls).size !== orderedRemoteAssetUrls.length
  ) {
    throw externalFailure(
      "needs_input",
      "miaoshou.edit_asset_order_mismatch",
      "Approved images must have one unique remote URL in the approved order"
    );
  }

  return Object.freeze({
    title: snapshot.title,
    notesText: snapshot.description,
    notes: snapshot.description,
    imgUrls: Object.freeze([...orderedRemoteAssetUrls]),
    sourceAttrs: Object.freeze(snapshot.attributes.map((attribute) => Object.freeze({
      name: miaoshouText(attribute.name),
      value: miaoshouText(attribute.value)
    })))
  });
}
