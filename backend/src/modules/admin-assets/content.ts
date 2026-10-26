import { fileTypeFromBuffer } from "file-type";
import { AdminAssetError, PrivateAssetProviderError } from "./errors.js";

const DELIVERABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PREFIX_BYTES = 4 * 1024;

function concat(chunks: Uint8Array[], total: number) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function timedRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new PrivateAssetProviderError("aborted");

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new PrivateAssetProviderError("unavailable"));
    }, timeoutMs);
  });
  let rejectAbort: ((reason: unknown) => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(new PrivateAssetProviderError("aborted"));
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([reader.read(), timeoutPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function inspectPrivateImage(input: {
  abortSignal: AbortSignal;
  contentType: string;
  expectedBytes: number;
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  maxBytes: number;
  stream: ReadableStream<Uint8Array>;
}) {
  if (!DELIVERABLE_TYPES.has(input.contentType)) {
    throw new AdminAssetError(
      "ASSET_CONTENT_INVALID",
      "The private asset content is not deliverable.",
      502,
    );
  }

  const reader = input.stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let ended = false;
  let remainder: Uint8Array | null = null;

  try {
    while (bytes < PREFIX_BYTES) {
      const result = await timedRead(
        reader,
        bytes === 0 ? input.firstByteTimeoutMs : input.idleTimeoutMs,
        input.abortSignal,
      );
      if (result.done) {
        ended = true;
        break;
      }
      if (result.value.byteLength === 0) continue;
      if (
        bytes + result.value.byteLength > input.maxBytes ||
        bytes + result.value.byteLength > input.expectedBytes
      ) {
        throw new AdminAssetError(
          "ASSET_CONTENT_INVALID",
          "The private asset content does not match its stored metadata.",
          502,
        );
      }
      const required = PREFIX_BYTES - bytes;
      if (result.value.byteLength > required) {
        chunks.push(result.value.subarray(0, required));
        remainder = result.value.subarray(required);
        bytes += required;
        break;
      }
      chunks.push(result.value);
      bytes += result.value.byteLength;
    }

    const prefix = concat(chunks, bytes);
    const textPrefix = new TextDecoder("utf-8", { fatal: false })
      .decode(prefix.subarray(0, 512))
      .replace(/^\uFEFF/, "")
      .trimStart()
      .toLowerCase();
    if (
      textPrefix.startsWith("<svg") ||
      textPrefix.startsWith("<!doctype html") ||
      textPrefix.startsWith("<html") ||
      textPrefix.startsWith("<script")
    ) {
      throw new AdminAssetError(
        "ASSET_CONTENT_INVALID",
        "The private asset content is not deliverable.",
        502,
      );
    }

    const detected = await fileTypeFromBuffer(prefix);
    if (!detected || detected.mime !== input.contentType) {
      throw new AdminAssetError(
        "ASSET_CONTENT_INVALID",
        "The private asset content does not match its stored metadata.",
        502,
      );
    }
    if (ended && bytes !== input.expectedBytes) {
      throw new AdminAssetError(
        "ASSET_CONTENT_INVALID",
        "The private asset content does not match its stored metadata.",
        502,
      );
    }

    let delivered = bytes;
    let terminal = ended;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const onAbort = () => {
      void reader.cancel(input.abortSignal.reason).catch(() => undefined);
      controller?.error(new PrivateAssetProviderError("aborted"));
    };
    input.abortSignal.addEventListener("abort", onAbort, { once: true });

    const stream = new ReadableStream<Uint8Array>({
      start(activeController) {
        controller = activeController;
        if (prefix.byteLength > 0) activeController.enqueue(prefix);
        if (ended) {
          input.abortSignal.removeEventListener("abort", onAbort);
          activeController.close();
        }
      },
      async pull(activeController) {
        if (terminal) return;
        try {
          if (remainder) {
            const queued = remainder;
            remainder = null;
            delivered += queued.byteLength;
            activeController.enqueue(queued);
            return;
          }
          const result = await timedRead(reader, input.idleTimeoutMs, input.abortSignal);
          if (result.done) {
            terminal = true;
            input.abortSignal.removeEventListener("abort", onAbort);
            if (delivered !== input.expectedBytes) {
              activeController.error(
                new AdminAssetError(
                  "ASSET_CONTENT_INVALID",
                  "The private asset stream ended before its expected length.",
                  502,
                ),
              );
              return;
            }
            activeController.close();
            return;
          }

          delivered += result.value.byteLength;
          if (delivered > input.expectedBytes || delivered > input.maxBytes) {
            terminal = true;
            input.abortSignal.removeEventListener("abort", onAbort);
            await reader.cancel("private asset exceeded its expected length");
            activeController.error(
              new AdminAssetError(
                "ASSET_CONTENT_INVALID",
                "The private asset exceeded its expected length.",
                502,
              ),
            );
            return;
          }
          activeController.enqueue(result.value);
        } catch (error) {
          terminal = true;
          input.abortSignal.removeEventListener("abort", onAbort);
          activeController.error(error);
        }
      },
      async cancel(reason) {
        terminal = true;
        input.abortSignal.removeEventListener("abort", onAbort);
        await reader.cancel(reason);
      }
    });

    return {
      bytesRead: () => delivered,
      stream
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

export function safeAssetFilename(filename: string | null, contentType: string) {
  const extension = contentType === "image/png"
    ? "png"
    : contentType === "image/webp"
      ? "webp"
      : "jpg";
  const cleaned = (filename ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]+/g, "-")
    .trim()
    .slice(0, 180)
    .replace(/[. -]+$/g, "");

  return cleaned || `customization.${extension}`;
}

export function contentDispositionHeader(
  disposition: "attachment" | "inline",
  filename: string,
) {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]+/g, "-")
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .trim() || "customization-image";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
