export type CustomerMessageChannel = "email" | "sms";
export type ConversationStatus =
  | "awaiting_admin"
  | "awaiting_customer"
  | "resolved";

export type MessagingActor = {
  authSubject: string;
  userId: string;
};

export type MessageContact = {
  address: string;
  channel: CustomerMessageChannel;
  preferred: boolean;
};

export type QueueReplyInput = {
  body: string;
  channel: CustomerMessageChannel;
  subject?: string | null;
};

export type QueueNoteInput = {
  body: string;
};

export type ConversationQuery = {
  adminUnread?: boolean;
  cursor?: string;
  limit: number;
  status?: ConversationStatus;
};

export type MessageView = {
  body: string;
  channel: CustomerMessageChannel | "internal_note" | "system";
  createdAt: string;
  direction: "inbound" | "outbound" | "internal";
  failedAt: string | null;
  failureCode: string | null;
  id: string;
  provider: string | null;
  sentAt: string | null;
  senderType: "customer" | "admin" | "system";
  status: "draft" | "queued" | "sent" | "failed";
  subject: string | null;
};

export type ConversationSummary = {
  adminUnread: boolean;
  availableChannels: CustomerMessageChannel[];
  customerName: string | null;
  lastMessageAt: string | null;
  orderId: string;
  preferredChannel: CustomerMessageChannel | null;
  publicOrderNumber: string;
  status: ConversationStatus;
  version: number;
};

export type ConversationDetail = ConversationSummary & {
  capabilities: {
    attachments: false;
    email: boolean;
    sms: boolean;
  };
  messages: MessageView[];
};

export type DeliveryMessage = {
  body: string;
  channel: CustomerMessageChannel;
  from: string;
  idempotencyKey: string;
  messageId: string;
  subject: string | null;
  threadKey: string;
  to: string;
};

export type DeliveryResult = {
  messageId: string;
  provider: string;
};

export type MessagingWebhookInput = {
  body?: string;
  channel: CustomerMessageChannel;
  errorCode?: string;
  eventId: string;
  from?: string;
  providerMessageId?: string;
  subject?: string;
  threadKey: string;
  timestamp: number;
  to?: string;
  type: "message.received" | "message.sent" | "message.failed";
};
