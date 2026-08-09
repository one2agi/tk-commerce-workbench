import { describe, expect, it } from "vitest";

import { SECRET_FIELD_NAMES, secretStatusFromSecrets } from "./runtime-configuration.js";

describe("runtime configuration contracts", () => {
  it("exposes only configured booleans for every supported secret", () => {
    const status = secretStatusFromSecrets({
      imageProviderApiKey: "provider-secret",
      extensionToken: "extension-secret",
      canvasApiKey: "   "
    });

    expect(Object.keys(status)).toEqual([...SECRET_FIELD_NAMES]);
    expect(status).toEqual({
      imagePlannerApiKey: false,
      imageProviderApiKey: true,
      canvasApiKey: false,
      llmApiKey: false,
      miaoshouAppKey: false,
      miaoshouAppSecret: false,
      miaoshouAuthorization: false,
      miaoshouCookie: false,
      assetPublishS3AccessKeyId: false,
      assetPublishS3SecretAccessKey: false,
      extensionToken: true
    });
    expect(JSON.stringify(status)).not.toContain("provider-secret");
    expect(JSON.stringify(status)).not.toContain("extension-secret");
  });
});
