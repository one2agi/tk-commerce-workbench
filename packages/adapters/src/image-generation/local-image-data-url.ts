import { readFile } from "node:fs/promises";

import { externalFailure, type ResolvedImageReferenceV1 } from "@tk/contracts";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type EncodedImageMessage = Readonly<{
  type: "image_url";
  image_url: Readonly<{ url: string; detail: "low" }>;
}>;

function mimeFor(reference: ResolvedImageReferenceV1, bytes: Buffer): "image/png" | "image/jpeg" {
  if (reference.extension === "png" && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if ((reference.extension === "jpg" || reference.extension === "jpeg") &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  throw externalFailure(
    "needs_input",
    "image_reference_unavailable",
    "A selected source image is not a valid PNG or JPEG"
  );
}

export async function encodeLocalImageReferences(
  references: readonly ResolvedImageReferenceV1[]
): Promise<EncodedImageMessage[]> {
  if (references.length > 6) {
    throw externalFailure(
      "needs_input",
      "image_reference_count_invalid",
      "Image generation accepts at most six source images"
    );
  }

  const messages: EncodedImageMessage[] = [];
  for (const reference of references) {
    let bytes: Buffer;
    try {
      bytes = await readFile(reference.localPath);
    } catch {
      throw externalFailure(
        "needs_input",
        "image_reference_unavailable",
        "A selected source image is unavailable locally"
      );
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw externalFailure(
        "needs_input",
        "image_reference_unavailable",
        "A selected source image is empty or exceeds the four MiB planning limit"
      );
    }
    const mime = mimeFor(reference, bytes);
    messages.push(Object.freeze({
      type: "image_url",
      image_url: Object.freeze({
        url: `data:${mime};base64,${bytes.toString("base64")}`,
        detail: "low"
      })
    }));
  }
  return messages;
}
