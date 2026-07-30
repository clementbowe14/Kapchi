import { upload } from "@vercel/blob/client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizationImageUpload } from "./CustomizationImageUpload";

vi.mock("@vercel/blob/client", () => ({
  upload: vi.fn()
}));

const uploadMock = vi.mocked(upload);
const fetchMock = vi.fn();

function renderUpload(onUploaded = vi.fn()) {
  render(
    <CustomizationImageUpload
      cartId="1d66d9cc-0987-46e1-b719-c3e5a09f5013"
      customizationSetId="fba94989-b950-4087-bac1-8c1ad4970655"
      listingId="396256fa-68f9-4882-934a-5cedffbd8204"
      onUploaded={onUploaded}
    />,
  );

  return onUploaded;
}

describe("CustomizationImageUpload", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("authorizes and uploads a selected customization image", async () => {
    const user = userEvent.setup();
    const onUploaded = renderUpload();
    const file = new File(["image-bytes"], "stole.png", { type: "image/png" });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access: "private",
          assetId: "asset-123",
          clientPayload: "{\"assetId\":\"asset-123\"}",
          maxBytes: 5242880,
          pathname: "kapchi/customization_image/asset-123/stole.png"
        }),
        { status: 200 },
      ),
    );
    uploadMock.mockResolvedValueOnce({
      contentDisposition: "attachment",
      contentType: "image/png",
      downloadUrl: "https://blob.example/stole.png?download=1",
      pathname: "kapchi/customization_image/asset-123/stole.png",
      url: "https://blob.example/stole.png"
    });

    await user.upload(screen.getByLabelText("Custom image"), file);
    await user.click(screen.getByRole("button", { name: "Upload image" }));

    await waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith({
        assetId: "asset-123",
        byteSize: file.size,
        contentType: "image/png",
        filename: "stole.png"
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/upload-intents",
      expect.objectContaining({
        credentials: "include",
        method: "POST"
      }),
    );
    expect(uploadMock).toHaveBeenCalledWith(
      "kapchi/customization_image/asset-123/stole.png",
      file,
      {
      access: "private",
      clientPayload: "{\"assetId\":\"asset-123\"}",
      contentType: "image/png",
      handleUploadUrl: "/api/blob/upload",
      headers: undefined
      },
    );
    expect(
      screen.getByText("stole.png is ready for this customization."),
    ).toBeInTheDocument();
  });

  it("shows a validation error for unsupported image types", async () => {
    const user = userEvent.setup();
    renderUpload();
    const file = new File(["image-bytes"], "stole.gif", { type: "image/gif" });

    fireEvent.change(screen.getByLabelText("Custom image"), {
      target: {
        files: [file],
      },
    });
    await user.click(screen.getByRole("button", { name: "Upload image" }));

    expect(screen.getByText("Use a JPEG, PNG, or WebP image.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("surfaces backend authorization errors", async () => {
    const user = userEvent.setup();
    renderUpload();
    const file = new File(["image-bytes"], "stole.webp", { type: "image/webp" });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "A matching guest cart session is required."
        }),
        { status: 403 },
      ),
    );

    await user.upload(screen.getByLabelText("Custom image"), file);
    await user.click(screen.getByRole("button", { name: "Upload image" }));

    expect(
      await screen.findByText("A matching guest cart session is required."),
    ).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
