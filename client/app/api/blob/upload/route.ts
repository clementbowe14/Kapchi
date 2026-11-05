import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { createHash, createHmac } from "node:crypto";

type UploadTokenAuthorization = {
  addRandomSuffix: boolean;
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  tokenPayload: string;
};

const backendBaseUrl =
  process.env.BACKEND_INTERNAL_URL ??
  `http://localhost:${process.env.BACKEND_PORT ?? "4000"}`;

function backendUrl(path: string) {
  const url = new URL(path, backendBaseUrl);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("BACKEND_INTERNAL_URL must use HTTPS in production.");
  }
  return url.toString();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function signedCallbackHeaders(body: unknown, tokenPayload: string | null | undefined) {
  const secret = process.env.ASSET_UPLOAD_CALLBACK_SECRET_CURRENT;
  const keyId = process.env.ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT;
  if (!secret || !keyId) return null;
  const parsed = typeof tokenPayload === "string" ? JSON.parse(tokenPayload) as { callbackNonce?: string } : tokenPayload as { callbackNonce?: string } | undefined;
  if (!parsed?.callbackNonce) throw new Error("Upload callback nonce is missing.");
  const timestamp = new Date().toISOString();
  const bodyHash = createHash("sha256").update(stable(body), "utf8").digest("hex");
  const signature = createHmac("sha256", secret).update(`${keyId}.${timestamp}.${parsed.callbackNonce}.${bodyHash}`).digest("hex");
  return {
    "x-kapchi-callback-key-id": keyId,
    "x-kapchi-callback-nonce": parsed.callbackNonce,
    "x-kapchi-callback-signature": signature,
    "x-kapchi-callback-timestamp": timestamp
  };
}

export function prepareCallbackBody(blob: unknown, tokenPayload: unknown) {
  const serialized = JSON.stringify({ blob, tokenPayload });
  return {
    parsed: JSON.parse(serialized) as { blob: unknown; tokenPayload: unknown },
    serialized
  };
}

function forwardedHeaders(request: Request) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");

  if (authorization) {
    headers.authorization = authorization;
  }

  if (cookie) {
    headers.cookie = cookie;
  }

  return headers;
}

async function readJsonResponse<T>(response: Response) {
  const body = (await response.json().catch(() => null)) as
    | { message?: string }
    | null;

  if (!response.ok) {
    throw new Error(body?.message ?? "Asset upload request failed.");
  }

  return body as T;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const response = await fetch(backendUrl("/assets/upload-token-authorizations"), {
          body: JSON.stringify({
            clientPayload,
            pathname,
          }),
          headers: forwardedHeaders(request),
          method: "POST",
        });
        const authorization =
          await readJsonResponse<UploadTokenAuthorization>(response);

        return {
          addRandomSuffix: authorization.addRandomSuffix,
          allowedContentTypes: authorization.allowedContentTypes,
          maximumSizeInBytes: authorization.maximumSizeInBytes,
          tokenPayload: authorization.tokenPayload,
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const headers = forwardedHeaders(request);
        const callbackBody = prepareCallbackBody(blob, tokenPayload);
        const signedHeaders = signedCallbackHeaders(callbackBody.parsed, tokenPayload);
        const callbackSecret = process.env.ASSET_UPLOAD_CALLBACK_SECRET;

        if (signedHeaders) {
          Object.assign(headers, signedHeaders);
        } else if (callbackSecret && process.env.NODE_ENV !== "production") {
          headers["x-kapchi-upload-callback-secret"] = callbackSecret;
        } else {
          throw new Error("Asset upload callback signing is not configured.");
        }

        const response = await fetch(backendUrl("/assets/upload-completions"), {
          body: callbackBody.serialized,
          headers,
          method: "POST",
        });

        await readJsonResponse(response);
      },
    });

    return Response.json(jsonResponse);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Upload failed.",
      },
      {
        status: 400,
      },
    );
  }
}
