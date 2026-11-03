import { MessageProviderError } from "./errors.js";
import type { DeliveryMessage, DeliveryResult } from "./types.js";

export interface MessageProvider {
  send(message: DeliveryMessage): Promise<DeliveryResult>;
}

type HttpMessageProviderConfig = {
  token?: string;
  url?: string;
};

export class HttpMessageProvider implements MessageProvider {
  constructor(private readonly config: HttpMessageProviderConfig) {}

  async send(message: DeliveryMessage): Promise<DeliveryResult> {
    if (!this.config.url || !this.config.token) {
      throw new MessageProviderError("MESSAGE_PROVIDER_NOT_CONFIGURED", false);
    }

    try {
      const response = await fetch(this.config.url, {
        body: JSON.stringify({
          body: message.body,
          channel: message.channel,
          from: message.from,
          subject: message.subject,
          threadKey: message.threadKey,
          to: message.to
        }),
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000)
      });

      if (!response.ok) {
        throw new MessageProviderError(
          `MESSAGE_PROVIDER_HTTP_${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }

      const payload = await response.json() as {
        messageId?: unknown;
        provider?: unknown;
      };
      if (
        typeof payload.messageId !== "string" ||
        payload.messageId.trim().length === 0 ||
        payload.messageId.length > 500 ||
        typeof payload.provider !== "string" ||
        !/^[a-z0-9_-]{1,50}$/i.test(payload.provider)
      ) {
        throw new MessageProviderError("MESSAGE_PROVIDER_INVALID_RESPONSE", false);
      }
      return { messageId: payload.messageId.trim(), provider: payload.provider.toLowerCase() };
    } catch (error) {
      if (error instanceof MessageProviderError) throw error;
      throw new MessageProviderError("MESSAGE_PROVIDER_UNAVAILABLE", true);
    }
  }
}
