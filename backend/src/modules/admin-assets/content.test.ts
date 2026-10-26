import { describe, expect, it } from "vitest";
import {
  contentDispositionHeader,
  inspectPrivateImage,
  safeAssetFilename
} from "./content.js";

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nzsAAAAASUVORK5CYII=",
    "base64",
  ),
);

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

describe("private image content safety", () => {
  it("removes path and header injection characters from filenames", () => {
    const filename = safeAssetFilename("../cresta\r\nX-Injected: yes\\final.png", "image/png");
    expect(filename).not.toMatch(/[\r\n/\\]/);
    expect(contentDispositionHeader("attachment", filename)).not.toContain("\r");
    expect(contentDispositionHeader("attachment", filename)).not.toContain("\n");
  });

  it("encodes Unicode filenames and supplies a safe ASCII fallback", () => {
    const header = contentDispositionHeader("inline", "escudo-peruano-ñ.png");
    expect(header).toContain("filename=\"escudo-peruano-n-.png\"");
    expect(header).toContain("filename*=UTF-8''escudo-peruano-%C3%B1.png");
  });

  it("uses a typed fallback for an empty filename", () => {
    expect(safeAssetFilename("\u0000/\\", "image/webp")).toBe("customization.webp");
  });

  it("detects a truncated provider stream before response headers", async () => {
    await expect(inspectPrivateImage({
      abortSignal: new AbortController().signal,
      contentType: "image/png",
      expectedBytes: png.byteLength + 1,
      firstByteTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxBytes: 1024,
      stream: stream(png)
    })).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });
  });

  it("detects content larger than the trusted provider metadata", async () => {
    await expect(inspectPrivateImage({
      abortSignal: new AbortController().signal,
      contentType: "image/png",
      expectedBytes: png.byteLength - 1,
      firstByteTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxBytes: 1024,
      stream: stream(png)
    })).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });
  });
});
