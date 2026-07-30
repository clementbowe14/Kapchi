import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

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
  return new URL(path, backendBaseUrl).toString();
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
        const callbackSecret = process.env.ASSET_UPLOAD_CALLBACK_SECRET;

        if (callbackSecret) {
          headers["x-kapchi-upload-callback-secret"] = callbackSecret;
        }

        const response = await fetch(backendUrl("/assets/upload-completions"), {
          body: JSON.stringify({
            blob,
            tokenPayload,
          }),
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
