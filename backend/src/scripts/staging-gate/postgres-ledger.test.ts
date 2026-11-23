import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresOwnershipLedger } from "./postgres-ledger.js";

const attempt = {
  attemptId: "stg_postgres_12345678",
  candidateSha: "a".repeat(40),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  ownerTokenHash: "b".repeat(64),
};

function ledgerWith(query: ReturnType<typeof vi.fn>) {
  return new PostgresOwnershipLedger(
    { query } as unknown as Pool,
    "c".repeat(64),
  );
}

describe("PostgreSQL staging attempt ownership", () => {
  it("creates an active parent attempt and verifies owner, candidate, and expiry", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          attempt_id: attempt.attemptId,
          candidate_sha: attempt.candidateSha,
          expires_at: attempt.expiresAt,
          owner_token_hash: attempt.ownerTokenHash,
          state: "active",
        }],
      });
    const ledger = ledgerWith(query);

    await expect(ledger.startAttempt(attempt)).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]![0])).toContain("insert into staging_gate_control.attempts");
    expect(query.mock.calls[0]![1]).toEqual([
      attempt.attemptId,
      attempt.candidateSha,
      attempt.ownerTokenHash,
      attempt.expiresAt,
    ]);
  });

  it.each([
    ["candidate_sha", "d".repeat(40)],
    ["owner_token_hash", "e".repeat(64)],
    ["expires_at", new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()],
    ["state", "cleaned"],
  ])("rejects an existing attempt with different %s", async (field, value) => {
    const row = {
      attempt_id: attempt.attemptId,
      candidate_sha: attempt.candidateSha,
      expires_at: attempt.expiresAt,
      owner_token_hash: attempt.ownerTokenHash,
      state: "active",
      [field]: value,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] });

    await expect(ledgerWith(query).startAttempt(attempt)).rejects.toThrow(
      "another owner, candidate, expiry, or terminal run",
    );
  });

  it("rejects invalid or unbounded attempts before touching PostgreSQL", async () => {
    const query = vi.fn();
    const ledger = ledgerWith(query);
    await expect(ledger.startAttempt({
      ...attempt,
      expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
    })).rejects.toThrow("ownership, candidate, or expiry is invalid");
    await expect(ledger.startAttempt({
      ...attempt,
      ownerTokenHash: "not-a-hash",
    })).rejects.toThrow("ownership, candidate, or expiry is invalid");
    expect(query).not.toHaveBeenCalled();
  });
});
