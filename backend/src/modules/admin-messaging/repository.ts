import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { MessagingError } from "./errors.js";
import type {
  ConversationDetail,
  ConversationQuery,
  ConversationStatus,
  ConversationSummary,
  CustomerMessageChannel,
  DeliveryMessage,
  MessageContact,
  MessageView,
  MessagingActor,
  MessagingWebhookInput,
  QueueNoteInput,
  QueueReplyInput
} from "./types.js";

type ConversationRow = QueryResultRow & {
  admin_unread: boolean;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  id: string | null;
  last_message_at: Date | string | null;
  order_id: string;
  preferred_contact_method: "email" | "sms" | "phone" | null;
  public_order_number: string;
  status: ConversationStatus | null;
  thread_key: string | null;
  version: string | number | null;
};

type MessageRow = QueryResultRow & {
  body: string;
  channel: MessageView["channel"];
  created_at: Date | string;
  direction: MessageView["direction"];
  failed_at: Date | string | null;
  id: string;
  provider: string | null;
  provider_error: string | null;
  sender_type: MessageView["senderType"];
  sent_at: Date | string | null;
  status: MessageView["status"];
  subject: string | null;
};

export type ClaimedDeliveryJob = {
  attemptCount: number;
  jobId: string;
  maxAttempts: number;
  message: DeliveryMessage;
};

type SenderConfig = {
  email?: string;
  sms?: string;
};

function iso(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizePhone(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function preferredChannel(value: ConversationRow["preferred_contact_method"]) {
  if (value === "email") return "email" as const;
  if (value === "sms" || value === "phone") return "sms" as const;
  return null;
}

function availableChannels(row: ConversationRow): CustomerMessageChannel[] {
  return [
    ...(row.customer_email ? ["email" as const] : []),
    ...(row.customer_phone ? ["sms" as const] : [])
  ];
}

function contactFor(row: ConversationRow, channel: CustomerMessageChannel): MessageContact {
  const address = channel === "email" ? row.customer_email : row.customer_phone;
  if (!address) {
    throw new MessagingError(
      "MESSAGE_CONTACT_UNAVAILABLE",
      `The customer does not have a ${channel} contact for this order.`,
      409,
    );
  }
  return {
    address,
    channel,
    preferred: preferredChannel(row.preferred_contact_method) === channel
  };
}

function summary(row: ConversationRow): ConversationSummary {
  return {
    adminUnread: row.admin_unread ?? false,
    availableChannels: availableChannels(row),
    customerName: row.customer_name,
    lastMessageAt: iso(row.last_message_at),
    orderId: row.order_id,
    preferredChannel: preferredChannel(row.preferred_contact_method),
    publicOrderNumber: row.public_order_number,
    status: row.status ?? "awaiting_admin",
    version: Number(row.version ?? 0)
  };
}

function message(row: MessageRow): MessageView {
  return {
    body: row.body,
    channel: row.channel,
    createdAt: iso(row.created_at)!,
    direction: row.direction,
    failedAt: iso(row.failed_at),
    failureCode: row.provider_error,
    id: row.id,
    provider: row.provider,
    sentAt: iso(row.sent_at),
    senderType: row.sender_type,
    status: row.status,
    subject: row.subject
  };
}

function requestFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function transaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const conversationColumns = `
  conversations.id,
  orders.id as order_id,
  orders.public_order_number,
  coalesce(contacts.contact_name, customers.full_name, orders.shipping_name) as customer_name,
  coalesce(contacts.email, customers.email, orders.customer_email) as customer_email,
  coalesce(contacts.phone, customers.phone, orders.customer_phone) as customer_phone,
  coalesce(contacts.preferred_contact_method, customers.preferred_contact_method, orders.preferred_contact_method) as preferred_contact_method,
  conversations.thread_key,
  conversations.status,
  coalesce(conversations.admin_unread, false) as admin_unread,
  conversations.version,
  conversations.last_message_at
`;

export class AdminMessagingRepository {
  constructor(private readonly pool: Pool) {}

  async resolveActor(authSubject: string): Promise<MessagingActor | null> {
    const result = await this.pool.query<{ id: string }>(
      `select id from users
       where auth_provider = 'clerk' and auth_subject = $1 and disabled_at is null
       limit 1`,
      [authSubject],
    );
    return result.rows[0] ? { authSubject, userId: result.rows[0].id } : null;
  }

  async list(query: ConversationQuery) {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const result = await this.pool.query<ConversationRow>(
      `
        select ${conversationColumns}
        from order_conversations conversations
        join orders on orders.id = conversations.order_id
        left join customers on customers.id = orders.customer_id
        left join customer_contacts contacts on contacts.id = orders.customer_contact_id
        where ($1::order_conversation_status is null or conversations.status = $1)
          and ($2::boolean is null or conversations.admin_unread = $2)
          and (
            $3::timestamptz is null
            or (conversations.last_message_at, conversations.id) < ($3, $4::uuid)
          )
        order by conversations.last_message_at desc, conversations.id desc
        limit $5
      `,
      [
        query.status ?? null,
        query.adminUnread ?? null,
        cursor?.timestamp ?? null,
        cursor?.id ?? null,
        query.limit + 1
      ],
    );
    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return {
      conversations: rows.map(summary),
      nextCursor: hasMore && last?.last_message_at
        ? this.encodeCursor(iso(last.last_message_at)!, last.id!)
        : null
    };
  }

  async detail(orderId: string): Promise<ConversationDetail> {
    const row = await this.orderConversation(this.pool, orderId);
    if (!row) {
      throw new MessagingError("ORDER_NOT_FOUND", "Order not found.", 404);
    }
    const messages = row.id
      ? await this.pool.query<MessageRow>(
          `select id, sender_type, channel, direction, status, subject, body,
                  provider, provider_error, sent_at, failed_at, created_at
           from order_messages
           where conversation_id = $1::uuid
           order by created_at, id`,
          [row.id],
        )
      : { rows: [] as MessageRow[] };
    const base = summary(row);
    return {
      ...base,
      capabilities: {
        attachments: false,
        email: base.availableChannels.includes("email"),
        sms: base.availableChannels.includes("sms")
      },
      messages: messages.rows.map(message)
    };
  }

  async queueReply(
    orderId: string,
    actor: MessagingActor,
    input: QueueReplyInput,
    idempotencyKey: string,
    senders: SenderConfig,
  ) {
    return transaction(this.pool, async (client) => {
      const order = await this.orderConversation(client, orderId, true);
      if (!order) throw new MessagingError("ORDER_NOT_FOUND", "Order not found.", 404);
      const contact = contactFor(order, input.channel);
      const from = input.channel === "email" ? senders.email : senders.sms;
      if (!from) {
        throw new MessagingError(
          "MESSAGE_CHANNEL_UNAVAILABLE",
          `${input.channel.toUpperCase()} delivery is not configured.`,
          503,
        );
      }
      const fingerprint = requestFingerprint({ orderId, ...input });
      const existing = await client.query<MessageRow & { order_id: string }>(
        `select id, order_id, sender_type, channel, direction, status, subject, body,
                provider, provider_error, sent_at, failed_at, created_at,
                metadata
         from order_messages where idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].order_id !== orderId ||
          existing.rows[0].channel !== input.channel ||
          existing.rows[0].body !== input.body.trim() ||
          existing.rows[0].subject !== (input.subject?.trim() || null)
        ) {
          throw new MessagingError(
            "MESSAGE_IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for a different message.",
            409,
          );
        }
        return { message: message(existing.rows[0]), replayed: true };
      }
      const conversationId = await this.ensureConversation(client, orderId);
      const inserted = await client.query<MessageRow>(
        `insert into order_messages (
           order_id, conversation_id, sender_type, sender_user_id,
           sender_authenticated_user_id, channel, direction, status,
           to_address, from_address, subject, body, idempotency_key, metadata
         ) values (
           $1::uuid, $2::uuid, 'admin', $3, $4::uuid, $5, 'outbound', 'queued',
           $6, $7, $8, $9, $10, $11::jsonb
         )
         returning id, sender_type, channel, direction, status, subject, body,
                   provider, provider_error, sent_at, failed_at, created_at`,
        [
          orderId,
          conversationId,
          actor.authSubject,
          actor.userId,
          input.channel,
          contact.address,
          from,
          input.subject?.trim() || null,
          input.body.trim(),
          idempotencyKey,
          JSON.stringify({ requestFingerprint })
        ],
      );
      const queued = inserted.rows[0]!;
      await client.query(
        `insert into message_delivery_jobs (order_message_id, idempotency_key)
         values ($1::uuid, $2)`,
        [queued.id, `message-delivery:${queued.id}`],
      );
      await client.query(
        `update order_conversations
         set status = 'awaiting_customer', admin_unread = false,
             last_message_at = now(), last_admin_message_at = now(),
             resolved_at = null, resolved_by_user_id = null, version = version + 1
         where id = $1::uuid`,
        [conversationId],
      );
      await this.recordEvent(client, orderId, actor, "order_message.queued", queued.id, {
        channel: input.channel
      });
      return { message: message(queued), replayed: false };
    });
  }

  async addNote(
    orderId: string,
    actor: MessagingActor,
    input: QueueNoteInput,
    idempotencyKey: string,
  ) {
    return transaction(this.pool, async (client) => {
      const order = await this.orderConversation(client, orderId, true);
      if (!order) throw new MessagingError("ORDER_NOT_FOUND", "Order not found.", 404);
      const fingerprint = requestFingerprint({ orderId, ...input });
      const existing = await client.query<MessageRow & { order_id: string }>(
        `select id, order_id, sender_type, channel, direction, status, subject, body,
                provider, provider_error, sent_at, failed_at, created_at,
                metadata
         from order_messages where idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].order_id !== orderId ||
          existing.rows[0].channel !== "internal_note" ||
          existing.rows[0].body !== input.body.trim()
        ) {
          throw new MessagingError(
            "MESSAGE_IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for a different note.",
            409,
          );
        }
        return { message: message(existing.rows[0]), replayed: true };
      }
      const conversationId = await this.ensureConversation(client, orderId);
      const inserted = await client.query<MessageRow>(
        `insert into order_messages (
           order_id, conversation_id, sender_type, sender_user_id,
           sender_authenticated_user_id, channel, direction, status,
           body, idempotency_key, sent_at, metadata
         ) values (
           $1::uuid, $2::uuid, 'admin', $3, $4::uuid,
           'internal_note', 'internal', 'sent', $5, $6, now(), $7::jsonb
         )
         returning id, sender_type, channel, direction, status, subject, body,
                   provider, provider_error, sent_at, failed_at, created_at`,
        [
          orderId,
          conversationId,
          actor.authSubject,
          actor.userId,
          input.body.trim(),
          idempotencyKey,
          JSON.stringify({ requestFingerprint })
        ],
      );
      const note = inserted.rows[0]!;
      await client.query(
        `update order_conversations
         set last_message_at = now(), last_admin_message_at = now(), version = version + 1
         where id = $1::uuid`,
        [conversationId],
      );
      await this.recordEvent(client, orderId, actor, "order_note.created", note.id, {
        visibility: "internal"
      });
      return { message: message(note), replayed: false };
    });
  }

  async updateConversation(
    orderId: string,
    actor: MessagingActor,
    action: "read" | "reopen" | "resolve",
    expectedVersion: number,
  ) {
    return transaction(this.pool, async (client) => {
      const order = await this.orderConversation(client, orderId, true);
      if (!order) throw new MessagingError("ORDER_NOT_FOUND", "Order not found.", 404);
      const conversationId = await this.ensureConversation(client, orderId);
      const result = await client.query<{ version: string; status: ConversationStatus }>(
        `update order_conversations
         set admin_unread = case when $2 = 'read' then false else admin_unread end,
             status = case
               when $2 = 'resolve' then 'resolved'::order_conversation_status
               when $2 = 'reopen' then 'awaiting_admin'::order_conversation_status
               else status
             end,
             resolved_at = case
               when $2 = 'resolve' then now()
               when $2 = 'reopen' then null
               else resolved_at
             end,
             resolved_by_user_id = case
               when $2 = 'resolve' then $3::uuid
               when $2 = 'reopen' then null
               else resolved_by_user_id
             end,
             version = version + 1
         where id = $1::uuid and version = $4
         returning version, status`,
        [conversationId, action, actor.userId, expectedVersion],
      );
      if (!result.rows[0]) {
        throw new MessagingError(
          "CONVERSATION_VERSION_CONFLICT",
          "The conversation changed. Refresh before trying again.",
          409,
        );
      }
      await this.recordEvent(client, orderId, actor, `conversation.${action}`, conversationId);
      return {
        status: result.rows[0].status,
        version: Number(result.rows[0].version)
      };
    });
  }

  async claimDeliveryJobs(limit: number, leaseOwner: string): Promise<ClaimedDeliveryJob[]> {
    const result = await this.pool.query<{
      attempt_count: number;
      body: string;
      channel: CustomerMessageChannel;
      from_address: string;
      idempotency_key: string;
      job_id: string;
      max_attempts: number;
      message_id: string;
      subject: string | null;
      thread_key: string;
      to_address: string;
    }>(
      `with candidates as (
         select jobs.id
         from message_delivery_jobs jobs
         where jobs.status in ('pending', 'retryable')
           and jobs.next_attempt_at <= now()
           and (jobs.lease_expires_at is null or jobs.lease_expires_at < now())
         order by jobs.next_attempt_at, jobs.created_at
         for update skip locked
         limit $1
       ), claimed as (
         update message_delivery_jobs jobs
         set status = 'leased', lease_owner = $2,
             lease_expires_at = now() + interval '2 minutes',
             attempt_count = attempt_count + 1
         from candidates
         where jobs.id = candidates.id
         returning jobs.*
       )
       select claimed.id as job_id, claimed.attempt_count, claimed.max_attempts,
              claimed.idempotency_key, messages.id as message_id, messages.channel,
              messages.to_address, messages.from_address, messages.subject,
              messages.body, conversations.thread_key
       from claimed
       join order_messages messages on messages.id = claimed.order_message_id
       join order_conversations conversations on conversations.id = messages.conversation_id`,
      [limit, leaseOwner],
    );
    return result.rows.map((row) => ({
      attemptCount: row.attempt_count,
      jobId: row.job_id,
      maxAttempts: row.max_attempts,
      message: {
        body: row.body,
        channel: row.channel,
        from: row.from_address,
        idempotencyKey: row.idempotency_key,
        messageId: row.message_id,
        subject: row.subject,
        threadKey: row.thread_key,
        to: row.to_address
      }
    }));
  }

  async completeDelivery(
    job: ClaimedDeliveryJob,
    leaseOwner: string,
    result: { messageId: string; provider: string },
  ) {
    return transaction(this.pool, async (client) => {
      const updated = await client.query<{ order_id: string; metadata: Record<string, unknown> }>(
        `with completed as (
           update message_delivery_jobs
           set status = 'succeeded', lease_owner = null, lease_expires_at = null,
               last_error_code = null
           where id = $1::uuid and lease_owner = $2 and status = 'leased'
           returning order_message_id
         )
         update order_messages messages
         set status = 'sent', provider = $3, provider_message_id = $4,
             provider_error = null, sent_at = now(), failed_at = null,
             attempt_count = $5, last_attempt_at = now()
         from completed
         where messages.id = completed.order_message_id
         returning messages.order_id, messages.metadata`,
        [job.jobId, leaseOwner, result.provider, result.messageId, job.attemptCount],
      );
      const row = updated.rows[0];
      if (!row) return false;
      await this.updateRefundEffect(client, row.metadata, "succeeded", null);
      await client.query(
        `insert into order_events (
           order_id, actor_type, actor_id, event_type, transition_key, metadata
         ) values ($1::uuid, 'system', 'message-delivery', 'order_message.sent', $2, $3::jsonb)
         on conflict (transition_key) where transition_key is not null do nothing`,
        [
          row.order_id,
          `message:${job.message.messageId}:sent`,
          JSON.stringify({ channel: job.message.channel, messageId: job.message.messageId })
        ],
      );
      return true;
    });
  }

  async failDelivery(
    job: ClaimedDeliveryJob,
    leaseOwner: string,
    code: string,
    retryable: boolean,
  ) {
    return transaction(this.pool, async (client) => {
      const shouldRetry = retryable && job.attemptCount < job.maxAttempts;
      const updated = await client.query<{
        metadata: Record<string, unknown>;
        order_id: string;
      }>(
        `with failed_job as (
           update message_delivery_jobs
           set status = $3::message_delivery_job_status,
               next_attempt_at = case
                 when $3 = 'retryable' then now() + make_interval(mins => least(60, (2 ^ least(attempt_count, 6))::integer))
                 else next_attempt_at
               end,
               lease_owner = null, lease_expires_at = null, last_error_code = $4
           where id = $1::uuid and lease_owner = $2 and status = 'leased'
           returning order_message_id
         )
         update order_messages messages
         set status = case when $3 = 'failed' then 'failed'::message_status else status end,
             provider_error = $4, attempt_count = $5, last_attempt_at = now(),
             failed_at = case when $3 = 'failed' then now() else failed_at end
         from failed_job
         where messages.id = failed_job.order_message_id
         returning messages.order_id, messages.metadata`,
        [
          job.jobId,
          leaseOwner,
          shouldRetry ? "retryable" : "failed",
          code,
          job.attemptCount
        ],
      );
      const row = updated.rows[0];
      if (!row) return false;
      if (!shouldRetry) {
        await this.updateRefundEffect(client, row.metadata, "failed", code);
        await client.query(
          `insert into order_events (
             order_id, actor_type, actor_id, event_type, transition_key, metadata
           ) values ($1::uuid, 'system', 'message-delivery', 'order_message.failed', $2, $3::jsonb)
           on conflict (transition_key) where transition_key is not null do nothing`,
          [
            row.order_id,
            `message:${job.message.messageId}:failed`,
            JSON.stringify({ errorCode: code, messageId: job.message.messageId })
          ],
        );
      }
      return true;
    });
  }

  async scheduleRefundNotification(
    operationId: string,
    senders: SenderConfig,
  ) {
    return transaction(this.pool, (client) =>
      this.scheduleRefundNotificationWithClient(client, operationId, senders),
    );
  }

  async scheduleRefundNotifications(limit: number, senders: SenderConfig) {
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<{ refund_operation_id: string }>(
        `select effects.refund_operation_id
         from refund_effects effects
         join refund_operations operations on operations.id = effects.refund_operation_id
         where effects.effect_type = 'customer_notification'
           and effects.requested and effects.status = 'pending'
           and operations.status = 'succeeded'
           and (effects.next_attempt_at is null or effects.next_attempt_at <= now())
         order by effects.created_at
         for update of effects skip locked
         limit $1`,
        [limit],
      );
      let scheduled = 0;
      for (const candidate of candidates.rows) {
        if (await this.scheduleRefundNotificationWithClient(
          client,
          candidate.refund_operation_id,
          senders,
        )) scheduled += 1;
      }
      return { attempted: candidates.rows.length, scheduled };
    });
  }

  async receiveWebhook(
    provider: string,
    input: MessagingWebhookInput,
    payloadHash: string,
  ) {
    return transaction(this.pool, async (client) => {
      const receipt = await client.query<{ id: string }>(
        `insert into messaging_webhook_events (
           provider, provider_event_id, payload_hash
         ) values ($1, $2, $3)
         on conflict (provider, provider_event_id) do nothing
         returning id`,
        [provider, input.eventId, payloadHash],
      );
      if (!receipt.rows[0]) {
        const existing = await client.query<{ payload_hash: string; status: string }>(
          `select payload_hash, status from messaging_webhook_events
           where provider = $1 and provider_event_id = $2`,
          [provider, input.eventId],
        );
        if (existing.rows[0]?.payload_hash !== payloadHash) {
          throw new MessagingError(
            "MESSAGE_WEBHOOK_REPLAY_CONFLICT",
            "Webhook event identity was reused with different content.",
            409,
          );
        }
        return { duplicate: true, status: existing.rows[0]?.status ?? "received" };
      }
      const conversation = await client.query<ConversationRow>(
        `select ${conversationColumns}
         from order_conversations conversations
         join orders on orders.id = conversations.order_id
         left join customers on customers.id = orders.customer_id
         left join customer_contacts contacts on contacts.id = orders.customer_contact_id
         where conversations.thread_key = $1
         for update of conversations`,
        [input.threadKey],
      );
      const row = conversation.rows[0];
      if (!row || !row.id) {
        await this.rejectWebhook(client, receipt.rows[0].id, "THREAD_NOT_FOUND");
        return { duplicate: false, errorCode: "THREAD_NOT_FOUND", status: "rejected" };
      }

      if (input.type === "message.received") {
        const expected = input.channel === "email"
          ? normalizeEmail(row.customer_email)
          : normalizePhone(row.customer_phone);
        const actual = input.channel === "email"
          ? normalizeEmail(input.from)
          : normalizePhone(input.from);
        if (!expected || expected !== actual || !input.body?.trim()) {
          await this.rejectWebhook(client, receipt.rows[0].id, "CONTACT_MISMATCH");
          return { duplicate: false, errorCode: "CONTACT_MISMATCH", status: "rejected" };
        }
        const inserted = await client.query<{ id: string }>(
          `insert into order_messages (
             order_id, conversation_id, sender_type, channel, direction, status,
             from_address, to_address, subject, body, provider,
             provider_message_id, provider_event_id, idempotency_key, sent_at,
             metadata
           ) values (
             $1::uuid, $2::uuid, 'customer', $3, 'inbound', 'sent',
             $4, $5, $6, $7, $8, $9, $10, $11, now(), '{}'::jsonb
           ) returning id`,
          [
            row.order_id,
            row.id,
            input.channel,
            input.from,
            input.to ?? null,
            input.subject?.trim() || null,
            input.body.trim(),
            provider,
            input.providerMessageId ?? null,
            input.eventId,
            `inbound:${provider}:${input.eventId}`
          ],
        );
        await client.query(
          `update order_conversations
           set status = 'awaiting_admin', admin_unread = true,
               resolved_at = null, resolved_by_user_id = null,
               last_message_at = now(), last_customer_message_at = now(),
               version = version + 1
           where id = $1::uuid`,
          [row.id],
        );
        await client.query(
          `update messaging_webhook_events
           set status = 'processed', order_message_id = $2::uuid, processed_at = now()
           where id = $1::uuid`,
          [receipt.rows[0].id, inserted.rows[0]!.id],
        );
        await client.query(
          `insert into order_events (
             order_id, actor_type, actor_id, event_type, transition_key, metadata
           ) values ($1::uuid, 'customer', $2, 'order_message.received', $3, $4::jsonb)
           on conflict (transition_key) where transition_key is not null do nothing`,
          [
            row.order_id,
            provider,
            `message-webhook:${provider}:${input.eventId}`,
            JSON.stringify({ channel: input.channel, messageId: inserted.rows[0]!.id })
          ],
        );
        return { duplicate: false, status: "processed" };
      }

      if (!input.providerMessageId) {
        await this.rejectWebhook(client, receipt.rows[0].id, "MESSAGE_ID_REQUIRED");
        return { duplicate: false, errorCode: "MESSAGE_ID_REQUIRED", status: "rejected" };
      }
      const status = input.type === "message.failed" ? "failed" : "sent";
      const updated = await client.query<{
        id: string;
        metadata: Record<string, unknown>;
      }>(
        `update order_messages
         set status = $4::message_status,
             provider_error = case when $4 = 'failed' then $5 else null end,
             failed_at = case when $4 = 'failed' then now() else failed_at end,
             sent_at = case when $4 = 'sent' then coalesce(sent_at, now()) else sent_at end
         where conversation_id = $1::uuid and provider = $2 and provider_message_id = $3
         returning id, metadata`,
        [row.id, provider, input.providerMessageId, status, input.errorCode ?? "MESSAGE_PROVIDER_FAILED"],
      );
      if (!updated.rows[0]) {
        await this.rejectWebhook(client, receipt.rows[0].id, "MESSAGE_NOT_FOUND");
        return { duplicate: false, errorCode: "MESSAGE_NOT_FOUND", status: "rejected" };
      }
      if (status === "failed") {
        const failureCode = input.errorCode ?? "MESSAGE_PROVIDER_FAILED";
        await client.query(
          `update message_delivery_jobs
           set status = 'failed', last_error_code = $2,
               lease_owner = null, lease_expires_at = null
           where order_message_id = $1::uuid`,
          [updated.rows[0].id, failureCode],
        );
        await this.updateRefundEffect(
          client,
          updated.rows[0].metadata,
          "failed",
          failureCode,
        );
      }
      await client.query(
        `update messaging_webhook_events
         set status = 'processed', order_message_id = $2::uuid, processed_at = now()
         where id = $1::uuid`,
        [receipt.rows[0].id, updated.rows[0].id],
      );
      return { duplicate: false, status: "processed" };
    });
  }

  private async orderConversation(
    client: Pick<Pool, "query"> | PoolClient,
    orderId: string,
    lock = false,
  ) {
    const result = await client.query<ConversationRow>(
      `select ${conversationColumns}
       from orders
       left join order_conversations conversations on conversations.order_id = orders.id
       left join customers on customers.id = orders.customer_id
       left join customer_contacts contacts on contacts.id = orders.customer_contact_id
       where orders.id = $1::uuid
       ${lock ? "for update of orders" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? null;
  }

  private async ensureConversation(client: PoolClient, orderId: string) {
    const result = await client.query<{ id: string }>(
      `insert into order_conversations (order_id, thread_key)
       values ($1::uuid, 'kapchi-order:' || $1::text)
       on conflict (order_id) do update set order_id = excluded.order_id
       returning id`,
      [orderId],
    );
    return result.rows[0]!.id;
  }

  private async recordEvent(
    client: PoolClient,
    orderId: string,
    actor: MessagingActor,
    eventType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ) {
    await client.query(
      `insert into order_events (
         order_id, actor_type, actor_id, actor_user_id, event_type,
         transition_key, metadata
       ) values ($1::uuid, 'admin', $2, $3::uuid, $4, $5, $6::jsonb)
       on conflict (transition_key) where transition_key is not null do nothing`,
      [
        orderId,
        actor.authSubject,
        actor.userId,
        eventType,
        `${eventType}:${targetId}`,
        JSON.stringify({ ...metadata, targetId })
      ],
    );
  }

  private async scheduleRefundNotificationWithClient(
    client: PoolClient,
    operationId: string,
    senders: SenderConfig,
  ) {
    const effect = await client.query<{
      amount_cents: number;
      currency: string;
      order_id: string;
      public_order_number: string;
      status: string;
    }>(
      `select operations.order_id, operations.amount_cents, operations.currency,
              operations.status, orders.public_order_number
       from refund_effects effects
       join refund_operations operations on operations.id = effects.refund_operation_id
       join orders on orders.id = operations.order_id
       where effects.refund_operation_id = $1::uuid
         and effects.effect_type = 'customer_notification'
         and effects.requested and effects.status = 'pending'
       for update of effects`,
      [operationId],
    );
    const row = effect.rows[0];
    if (!row || row.status !== "succeeded") return false;
    const order = await this.orderConversation(client, row.order_id, true);
    if (!order) return false;
    const channel = preferredChannel(order.preferred_contact_method)
      ?? availableChannels(order)[0];
    if (!channel) {
      await client.query(
        `update refund_effects
         set status = 'failed', last_error_code = 'MESSAGE_CONTACT_UNAVAILABLE',
             failed_at = now(), attempt_count = attempt_count + 1
         where refund_operation_id = $1::uuid and effect_type = 'customer_notification'`,
        [operationId],
      );
      return false;
    }
    const from = channel === "email" ? senders.email : senders.sms;
    if (!from) {
      await client.query(
        `update refund_effects
         set status = 'failed', last_error_code = 'MESSAGE_CHANNEL_UNAVAILABLE',
             failed_at = now(), attempt_count = attempt_count + 1
         where refund_operation_id = $1::uuid and effect_type = 'customer_notification'`,
        [operationId],
      );
      return false;
    }
    const contact = contactFor(order, channel);
    const conversationId = await this.ensureConversation(client, row.order_id);
    const key = `refund:${operationId}:notification`;
    const inserted = await client.query<{ id: string }>(
      `insert into order_messages (
         order_id, conversation_id, sender_type, sender_user_id, channel,
         direction, status, to_address, from_address, subject, body,
         idempotency_key, metadata
       ) values (
         $1::uuid, $2::uuid, 'system', 'refund-notification', $3,
         'outbound', 'queued', $4, $5, $6, $7, $8, $9::jsonb
       )
       on conflict (idempotency_key) where idempotency_key is not null do nothing
       returning id`,
      [
        row.order_id,
        conversationId,
        channel,
        contact.address,
        from,
        `Refund processed for order ${row.public_order_number}`,
        `Your refund of ${row.amount_cents} ${row.currency.toUpperCase()} minor units has been processed for order ${row.public_order_number}.`,
        key,
        JSON.stringify({ refundOperationId: operationId })
      ],
    );
    const messageId = inserted.rows[0]?.id;
    if (messageId) {
      await client.query(
        `insert into message_delivery_jobs (order_message_id, idempotency_key)
         values ($1::uuid, $2)`,
        [messageId, `message-delivery:${messageId}`],
      );
      await client.query(
        `update order_conversations
         set status = 'awaiting_customer', admin_unread = false,
             last_message_at = now(), last_admin_message_at = now(),
             resolved_at = null, resolved_by_user_id = null, version = version + 1
         where id = $1::uuid`,
        [conversationId],
      );
    }
    return Boolean(messageId);
  }

  private async updateRefundEffect(
    client: PoolClient,
    metadata: Record<string, unknown>,
    status: "failed" | "succeeded",
    errorCode: string | null,
  ) {
    if (typeof metadata.refundOperationId !== "string") return;
    await client.query(
      `update refund_effects
       set status = $2::refund_effect_status,
           last_error_code = $3,
           succeeded_at = case
             when $2 = 'succeeded' then now()
             when $2 = 'failed' then null
             else succeeded_at
           end,
           failed_at = case when $2 = 'failed' then now() else failed_at end,
           attempt_count = attempt_count + 1
       where refund_operation_id = $1::uuid
         and effect_type = 'customer_notification'
         and (
           status = 'pending'
           or ($2 = 'failed' and status = 'succeeded')
         )`,
      [metadata.refundOperationId, status, errorCode],
    );
  }

  private async rejectWebhook(client: PoolClient, id: string, code: string) {
    await client.query(
      `update messaging_webhook_events
       set status = 'rejected', error_code = $2, processed_at = now()
       where id = $1::uuid`,
      [id, code],
    );
  }

  private encodeCursor(timestamp: string, id: string) {
    return Buffer.from(JSON.stringify({ id, timestamp }), "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
        id?: unknown;
        timestamp?: unknown;
      };
      if (typeof parsed.id !== "string" || typeof parsed.timestamp !== "string") {
        throw new Error("invalid");
      }
      return { id: parsed.id, timestamp: parsed.timestamp };
    } catch {
      throw new MessagingError("INVALID_CURSOR", "Conversation cursor is invalid.", 400);
    }
  }
}
