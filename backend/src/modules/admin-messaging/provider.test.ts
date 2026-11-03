import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageProviderError } from "./errors.js";
import { HttpMessageProvider } from "./provider.js";

const message = {
  body: "Your order is ready.",
  channel: "email" as const,
  from: "support@example.test",
  idempotencyKey: "delivery-key",
  messageId: "message-id",
  subject: "Order update",
  threadKey: "kapchi-order:order-id",
  to: "customer@example.test"
};

describe("HttpMessageProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails permanently when delivery is not configured", async () => {
    const provider = new HttpMessageProvider({});

    await expect(provider.send(message)).rejects.toEqual(
      expect.objectContaining({
        code: "MESSAGE_PROVIDER_NOT_CONFIGURED",
        retryable: false
      }),
    );
  });

  it("classifies transient provider responses for retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const provider = new HttpMessageProvider({ token: "test-token", url: "https://gateway.test/messages" });

    await expect(provider.send(message)).rejects.toEqual(
      expect.objectContaining({ code: "MESSAGE_PROVIDER_HTTP_503", retryable: true }),
    );
  });

  it("sends a provider-neutral request with durable idempotency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ messageId: "provider-message", provider: "sandbox" }),
      { headers: { "content-type": "application/json" }, status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HttpMessageProvider({ token: "test-token", url: "https://gateway.test/messages" });

    await expect(provider.send(message)).resolves.toEqual({
      messageId: "provider-message",
      provider: "sandbox"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.test/messages",
      expect.objectContaining({
        headers: expect.objectContaining({ "idempotency-key": "delivery-key" }),
        method: "POST"
      }),
    );
  });

  it("does not expose provider response bodies through errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "secret provider diagnostic",
      { status: 400 },
    )));
    const provider = new HttpMessageProvider({ token: "test-token", url: "https://gateway.test/messages" });

    const error = await provider.send(message).catch((caught) => caught);
    expect(error).toBeInstanceOf(MessageProviderError);
    expect(String(error)).not.toContain("secret provider diagnostic");
  });

  it.each([
    { messageId: "", provider: "sandbox" },
    { messageId: "message-id", provider: "unsafe provider name" },
    { messageId: "x".repeat(501), provider: "sandbox" }
  ])("rejects unsafe provider identities without persisting them", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(payload),
      { headers: { "content-type": "application/json" }, status: 200 },
    )));
    const provider = new HttpMessageProvider({
      token: "test-token",
      url: "https://gateway.test/messages"
    });

    await expect(provider.send(message)).rejects.toEqual(expect.objectContaining({
      code: "MESSAGE_PROVIDER_INVALID_RESPONSE",
      retryable: false
    }));
  });
});
