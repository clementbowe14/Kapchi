import { describe, expect, it, vi } from "vitest";
import { ClerkStagingAdapter } from "./clerk-adapter.js";

const attemptId = "stg_clerk_12345678";
const namespace = `kapchi-stg-stg-clerk-12345678-${"a".repeat(12)}`;
const targetIdentity = "ins_staging_123";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("Clerk staging adapter ownership", () => {
  it("provisions admin metadata and exposes only non-secret binding data", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: targetIdentity }))
      .mockResolvedValueOnce(json([]))
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          external_id: string;
          public_metadata: { roles: string[] };
        };
        return json({
          external_id: body.external_id,
          id: "user_admin",
          public_metadata: body.public_metadata,
        }, 201);
      });
    const adapter = new ClerkStagingAdapter(
      targetIdentity,
      "sk_test_clerk-staging-secret-123",
      fetchMock as unknown as typeof fetch,
    );
    const adminIntent = adapter.plan({ attemptId, namespace })[2]!;

    const fixture = await adapter.provision(adminIntent);

    const createInit = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(JSON.parse(String(createInit.body))).toMatchObject({
      external_id: `kapchi-staging:${adminIntent.intentId}`,
      public_metadata: { roles: ["admin"] },
    });
    expect(fixture.publicFixture).toEqual({
      adminBinding: { authSubject: "user_admin" },
      attemptId,
      externalId: `kapchi-staging:${adminIntent.intentId}`,
      role: "admin",
      subject: "user_admin",
      type: "clerk-identity",
    });
    expect(JSON.stringify(fixture.publicFixture)).not.toContain("sk_test_");
  });

  it("verifies the instance and exact external ID before revoking or deleting", async () => {
    const adapterForIntent = new ClerkStagingAdapter(
      targetIdentity,
      "sk_test_clerk-staging-secret-123",
      vi.fn() as unknown as typeof fetch,
    );
    const intent = adapterForIntent.plan({ attemptId, namespace })[0]!;
    const resource = {
      attemptId,
      createdAt: intent.createdAt,
      externalId: "user_customer",
      intentId: intent.intentId,
      kind: "clerk" as const,
      namespace,
      targetIdentity,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: targetIdentity }))
      .mockResolvedValueOnce(json({
        external_id: `kapchi-staging:${intent.intentId}`,
        id: resource.externalId,
      }))
      .mockResolvedValueOnce(json([{ id: "sess_active", status: "active" }]))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = new ClerkStagingAdapter(
      targetIdentity,
      "sk_test_clerk-staging-secret-123",
      fetchMock as unknown as typeof fetch,
    );

    await expect(adapter.cleanup(resource)).resolves.toBe("deleted");

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      ["https://api.clerk.com/v1/instance", "GET"],
      ["https://api.clerk.com/v1/users/user_customer", "GET"],
      ["https://api.clerk.com/v1/sessions?limit=100&user_id=user_customer", "GET"],
      ["https://api.clerk.com/v1/sessions/sess_active/revoke", "POST"],
      ["https://api.clerk.com/v1/users/user_customer", "DELETE"],
    ]);
  });

  it("refuses a foreign user or Clerk instance before destructive requests", async () => {
    const planner = new ClerkStagingAdapter(
      targetIdentity,
      "sk_test_clerk-staging-secret-123",
      vi.fn() as unknown as typeof fetch,
    );
    const intent = planner.plan({ attemptId, namespace })[0]!;
    const resource = {
      attemptId,
      createdAt: intent.createdAt,
      externalId: "user_customer",
      intentId: intent.intentId,
      kind: "clerk" as const,
      namespace,
      targetIdentity,
    };
    const foreignUserFetch = vi.fn()
      .mockResolvedValueOnce(json({ id: targetIdentity }))
      .mockResolvedValueOnce(json({ external_id: "kapchi-staging:intent_foreign", id: "user_customer" }));
    const foreignUserAdapter = new ClerkStagingAdapter(
      targetIdentity,
      "sk_test_clerk-staging-secret-123",
      foreignUserFetch as unknown as typeof fetch,
    );
    await expect(foreignUserAdapter.cleanup(resource)).rejects.toThrow("exact durable ownership");
    expect(foreignUserFetch).toHaveBeenCalledTimes(2);

    const foreignInstanceFetch = vi.fn().mockResolvedValueOnce(json({ id: "ins_production" }));
    const foreignInstanceAdapter = new ClerkStagingAdapter(
      targetIdentity,
      "sk_test_clerk-staging-secret-123",
      foreignInstanceFetch as unknown as typeof fetch,
    );
    await expect(foreignInstanceAdapter.cleanup(resource)).rejects.toThrow("configured staging target");
    expect(foreignInstanceFetch).toHaveBeenCalledTimes(1);
  });
});
