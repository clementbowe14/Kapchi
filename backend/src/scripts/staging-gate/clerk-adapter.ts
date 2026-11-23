import { createHash } from "node:crypto";
import {
  deterministicIntentId,
  deterministicProviderIdempotencyKey,
} from "./fixture-runner.js";
import type {
  CreationIntent,
  OwnedResource,
  ProvisionedFixture,
  StagingProviderAdapter,
} from "./types.js";

type ClerkInstance = { id?: string };
type ClerkUser = {
  external_id?: string | null;
  id?: string;
  public_metadata?: { roles?: unknown };
};
type ClerkSession = { id?: string; status?: string };

const API_ORIGIN = "https://api.clerk.com";
const IDENTITIES = [
  { clerkRoles: [] as string[], role: "customer" },
  { clerkRoles: [] as string[], role: "nonAdmin" },
  { clerkRoles: ["admin"], role: "admin" },
] as const;

export class ClerkStagingAdapter implements StagingProviderAdapter {
  readonly kind = "clerk" as const;

  constructor(
    readonly targetIdentity: string,
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!secretKey.startsWith("sk_test_")) {
      throw new Error("Staging identity cleanup requires a Clerk test-instance secret key.");
    }
  }

  plan({ attemptId, namespace }: { attemptId: string; namespace: string }) {
    return IDENTITIES.map(({ role }) => {
      const base = {
        attemptId,
        createdAt: new Date().toISOString(),
        kind: this.kind,
        namespace,
        providerKeyHash: createHash("sha256").update(`${this.targetIdentity}:${role}`).digest("hex"),
        targetIdentity: this.targetIdentity,
      };
      return {
        ...base,
        idempotencyKey: deterministicProviderIdempotencyKey(base),
        intentId: deterministicIntentId(base),
      };
    });
  }

  async provision(intent: CreationIntent): Promise<ProvisionedFixture> {
    const existing = await this.recover(intent);
    if (existing) return existing;
    const identity = this.identityFor(intent);
    const response = await this.request("/v1/users", {
      body: JSON.stringify({
        email_address: [`${intent.intentId}+clerk_test@example.com`],
        external_id: this.externalId(intent),
        first_name: "Kapchi",
        last_name: `Staging ${identity.role}`,
        public_metadata: { roles: identity.clerkRoles },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const user = await response.json() as ClerkUser;
    if (!user.id || user.external_id !== this.externalId(intent)) {
      throw new Error("Clerk returned a malformed or foreign staging user.");
    }
    this.assertRoleMetadata(user, identity.clerkRoles);
    return this.fixture(intent, user.id, identity.role);
  }

  async recover(intent: CreationIntent): Promise<ProvisionedFixture | null> {
    await this.assertTargetIdentity();
    const identity = this.identityFor(intent);
    const query = new URLSearchParams({ limit: "2" });
    query.append("external_id[]", this.externalId(intent));
    const response = await this.request(`/v1/users?${query}`, {}, [200]);
    const payload = await response.json() as ClerkUser[] | { data?: ClerkUser[] };
    const users = Array.isArray(payload) ? payload : payload.data ?? [];
    const matches = users.filter((user) => user.external_id === this.externalId(intent));
    if (matches.length > 1) throw new Error("Clerk staging ownership is ambiguous.");
    const user = matches[0];
    if (!user?.id) return null;
    this.assertRoleMetadata(user, identity.clerkRoles);
    return this.fixture(intent, user.id, identity.role);
  }

  async cleanup(resource: OwnedResource) {
    await this.assertTargetIdentity();
    const expectedExternalId = this.externalId(resource);
    const userResponse = await this.request(
      `/v1/users/${encodeURIComponent(resource.externalId)}`,
      {},
      [200, 404],
    );
    if (userResponse.status === 404) return "already_clean" as const;
    const user = await userResponse.json() as ClerkUser;
    if (user.id !== resource.externalId || user.external_id !== expectedExternalId) {
      throw new Error("Refusing to clean a Clerk user without exact durable ownership.");
    }
    const sessionsResponse = await this.request(
      `/v1/sessions?${new URLSearchParams({ limit: "100", user_id: resource.externalId })}`,
      {},
      [200],
    );
    const payload = await sessionsResponse.json() as ClerkSession[] | { data?: ClerkSession[] };
    const sessions = Array.isArray(payload) ? payload : payload.data ?? [];
    for (const session of sessions) {
      if (session.id && session.status !== "revoked" && session.status !== "ended") {
        await this.request(`/v1/sessions/${encodeURIComponent(session.id)}/revoke`, { method: "POST" }, [200, 404]);
      }
    }
    await this.request(`/v1/users/${encodeURIComponent(resource.externalId)}`, { method: "DELETE" }, [200, 204, 404]);
    return "deleted" as const;
  }

  async isClean(resource: OwnedResource) {
    await this.assertTargetIdentity();
    const response = await this.request(
      `/v1/users/${encodeURIComponent(resource.externalId)}`,
      {},
      [200, 404],
    );
    if (response.status === 404) return true;
    const user = await response.json() as ClerkUser;
    if (user.id !== resource.externalId || user.external_id !== this.externalId(resource)) {
      throw new Error("Clerk user no longer matches the durable cleanup ownership record.");
    }
    return false;
  }

  private externalId(intent: Pick<CreationIntent, "intentId">) {
    return `kapchi-staging:${intent.intentId}`;
  }

  private identityFor(intent: CreationIntent) {
    const identity = IDENTITIES.find(({ role }) =>
      createHash("sha256").update(`${this.targetIdentity}:${role}`).digest("hex") === intent.providerKeyHash,
    );
    if (!identity) throw new Error("Clerk creation intent does not identify a reviewed staging role.");
    return identity;
  }

  private assertRoleMetadata(user: ClerkUser, expectedRoles: readonly string[]) {
    const roles = user.public_metadata?.roles;
    if (
      !Array.isArray(roles) ||
      roles.some((role) => typeof role !== "string") ||
      JSON.stringify([...roles].sort()) !== JSON.stringify([...expectedRoles].sort())
    ) {
      throw new Error("Clerk staging user has unexpected role metadata.");
    }
  }

  private fixture(intent: CreationIntent, userId: string, role: string): ProvisionedFixture {
    return {
      publicFixture: {
        attemptId: intent.attemptId,
        externalId: this.externalId(intent),
        role,
        subject: userId,
        type: "clerk-identity",
        ...(role === "admin" ? { adminBinding: { authSubject: userId } } : {}),
      },
      resource: this.resource(intent, userId),
    };
  }

  private async assertTargetIdentity() {
    const response = await this.request("/v1/instance", {}, [200]);
    const instance = await response.json() as ClerkInstance;
    if (instance.id !== this.targetIdentity) {
      throw new Error("Refusing a Clerk instance that does not match the configured staging target.");
    }
  }

  private resource(intent: CreationIntent, userId: string): OwnedResource {
    return {
      attemptId: intent.attemptId,
      createdAt: intent.createdAt,
      externalId: userId,
      intentId: intent.intentId,
      kind: this.kind,
      namespace: intent.namespace,
      targetIdentity: this.targetIdentity,
    };
  }

  private async request(path: string, init: RequestInit = {}, accepted = [200, 201]) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          ...init.headers,
        },
        redirect: "error",
      });
      if (accepted.includes(response.status)) return response;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Error(`Clerk staging operation failed with HTTP ${response.status}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
    throw new Error("Clerk staging operation exhausted its retry budget.");
  }
}
