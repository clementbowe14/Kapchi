"use client";

import { upload } from "@vercel/blob/client";
import { type FormEvent, useRef, useState } from "react";
import { buildApiUrl } from "@/lib/api";

type UploadState = "idle" | "loading" | "success" | "error";

export type CustomizationImageAsset = {
  assetId: string;
  byteSize: number;
  contentType: string;
  filename: string;
};

export type CustomizationImageUploadProps = {
  acceptedContentTypes?: string[];
  authorizationToken?: string | null;
  cartId: string;
  customizationSetId: string;
  listingId: string;
  maxBytes?: number | null;
  onUploaded?: (asset: CustomizationImageAsset) => void;
};

type UploadIntentResponse = {
  access: "private" | "public";
  assetId: string;
  clientPayload: string;
  maxBytes: number;
  pathname: string;
};

const acceptedImageTypes = ["image/jpeg", "image/png", "image/webp"];

async function createUploadIntent({
  authorizationToken,
  cartId,
  customizationSetId,
  file,
  listingId,
}: {
  authorizationToken?: string | null;
  cartId: string;
  customizationSetId: string;
  file: File;
  listingId: string;
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (authorizationToken) {
    headers.authorization = `Bearer ${authorizationToken}`;
  }

  const response = await fetch(buildApiUrl("/assets/upload-intents"), {
    body: JSON.stringify({
      byteSize: file.size,
      cartId,
      contentType: file.type,
      context: "customization_image",
      customizationSetId,
      filename: file.name,
      listingId,
    }),
    credentials: "include",
    headers,
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as
    | ({ message?: string } & Partial<UploadIntentResponse>)
    | null;

  if (!response.ok) {
    throw new Error(body?.message ?? "Image upload could not be authorized.");
  }

  if (!body?.assetId || !body.clientPayload || !body.pathname || !body.access) {
    throw new Error("Image upload authorization response was incomplete.");
  }

  return body as UploadIntentResponse;
}

export function CustomizationImageUpload({
  acceptedContentTypes = acceptedImageTypes,
  authorizationToken,
  cartId,
  customizationSetId,
  listingId,
  maxBytes,
  onUploaded,
}: CustomizationImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];

    if (!file) {
      setError("Choose an image before uploading.");
      setState("error");
      return;
    }

    if (!acceptedContentTypes.includes(file.type)) {
      setError("Choose an accepted image format.");
      setState("error");
      return;
    }

    if (maxBytes !== null && maxBytes !== undefined && file.size > maxBytes) {
      setError(`Choose an image smaller than ${Math.ceil(maxBytes / 1_000_000)} MB.`);
      setState("error");
      return;
    }

    setError(null);
    setState("loading");

    try {
      const intent = await createUploadIntent({
        authorizationToken,
        cartId,
        customizationSetId,
        file,
        listingId,
      });

      await upload(intent.pathname, file, {
        access: intent.access,
        clientPayload: intent.clientPayload,
        contentType: file.type,
        handleUploadUrl: "/api/blob/upload",
        headers: authorizationToken
          ? {
              authorization: `Bearer ${authorizationToken}`,
            }
          : undefined,
      });

      setFilename(file.name);
      setState("success");
      onUploaded?.({
        assetId: intent.assetId,
        byteSize: file.size,
        contentType: file.type,
        filename: file.name,
      });
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Image upload failed.",
      );
      setState("error");
    }
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <label className="block text-sm font-semibold text-slate-900">
        Custom image
        <input
          ref={inputRef}
          accept={acceptedContentTypes.join(",")}
          className="mt-2 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 file:mr-4 file:rounded-md file:border-0 file:bg-[#b49872] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
          name="customization-image"
          type="file"
        />
      </label>

      <button
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#b49872] px-5 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(143,115,79,0.20)] transition hover:bg-[#a1845f] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none"
        disabled={state === "loading"}
        type="submit"
      >
        {state === "loading" ? "Uploading..." : "Upload image"}
      </button>

      {state === "success" && filename ? (
        <p className="text-sm font-medium text-emerald-700">
          {filename} is ready for this customization.
        </p>
      ) : null}

      {state === "error" && error ? (
        <p className="text-sm font-medium text-rose-700">{error}</p>
      ) : null}
    </form>
  );
}
