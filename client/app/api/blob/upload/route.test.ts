import { describe, expect, it } from "vitest";
import { prepareCallbackBody } from "./route";

describe("blob upload callback serialization", () => {
  it("signs the same representation that the backend receives", () => {
    const callback = prepareCallbackBody(
      { pathname: "kapchi/assets/example.png", optional: undefined },
      JSON.stringify({ assetId: "asset-1", callbackNonce: "nonce-1" }),
    );

    expect(callback.serialized).toBe(JSON.stringify(callback.parsed));
    expect(callback.parsed.blob).toEqual({ pathname: "kapchi/assets/example.png" });
  });
});
