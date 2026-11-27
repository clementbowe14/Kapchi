import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AdminOrderRepository, escapeOrderSearch } from "./repository.js";
import type { AdminOrderSearchQuery } from "./types.js";

describe("admin order search helpers", () => {
  it("escapes LIKE wildcard and escape characters", () => {
    expect(escapeOrderSearch("50%_off\\today")).toBe("50\\%\\_off\\\\today");
  });
});

describe("admin order search pagination", () => {
  it("binds the exact cursor timestamp without exposing it as the public timestamp", async () => {
    const preciseTimestamp = "2026-10-25T12:00:00.123456Z";
    const id = "11111111-1111-4111-8111-111111111111";
    const row = {
      captured_amount_cents: null,
      captured_currency: null,
      created_at: new Date(preciseTimestamp),
      currency: "usd",
      cursor_created_at: preciseTimestamp,
      id,
      updated_at: new Date(preciseTimestamp)
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row, row] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() }))
    } as unknown as Pick<Pool, "connect">;
    const repository = new AdminOrderRepository(pool);
    const filters: AdminOrderSearchQuery = {
      currency: "usd",
      discountedOnly: false,
      lifecycle: "all",
      limit: 1,
      paidOnly: true,
      refundedOnly: false,
      sort: "created_desc"
    };

    const first = await repository.search(filters);
    expect(first.orders.map((order) => order.createdAt)).toEqual(["2026-10-25T12:00:00.123Z"]);
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor!;
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).toEqual({
      createdAt: preciseTimestamp,
      id,
      sort: "created_desc"
    });

    await repository.search({ ...filters, cursor });
    expect(query.mock.calls[1][1].slice(13)).toEqual([preciseTimestamp, id, 2, "usd"]);
  });
});
