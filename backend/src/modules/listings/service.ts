import type { FastifyBaseLogger } from "fastify";
import type { GraduationStoleDetail, GraduationStoleSummary } from "./types.js";
import { ListingNotFoundError, ListingsUnavailableError } from "./errors.js";

export type ListingsReader = {
  getGraduationStole(slug: string): Promise<GraduationStoleDetail | null>;
  listGraduationStoles(): Promise<GraduationStoleSummary[]>;
};

type Delay = (milliseconds: number) => Promise<void>;
type RetryOptions = {
  baseDelayMs?: number;
  delay?: Delay;
  maxAttempts?: number;
  random?: () => number;
};

const TRANSIENT_SQLSTATES = new Set([
  "40001", "40P01", "53300", "55P03", "57014", "57P01", "57P02", "57P03",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01"
]);

function sqlState(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function isTransientPostgresError(error: unknown) {
  const code = sqlState(error);
  return code !== null && TRANSIENT_SQLSTATES.has(code);
}

const sleep: Delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ListingsService {
  private readonly baseDelayMs: number;
  private readonly delay: Delay;
  private readonly maxAttempts: number;
  private readonly random: () => number;

  constructor(
    private readonly repository: ListingsReader,
    private readonly logger: Pick<FastifyBaseLogger, "error" | "warn">,
    options: RetryOptions = {},
  ) {
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new RangeError("maxAttempts must be between 1 and 3.");
    }

    this.baseDelayMs = options.baseDelayMs ?? 50;
    this.delay = options.delay ?? sleep;
    this.maxAttempts = maxAttempts;
    this.random = options.random ?? Math.random;
  }

  async list(requestId: string) {
    return this.withRetry("list", requestId, null, () =>
      this.repository.listGraduationStoles(),
    );
  }

  async detail(requestId: string, slug: string) {
    const listing = await this.withRetry("detail", requestId, slug, () =>
      this.repository.getGraduationStole(slug),
    );
    if (!listing) throw new ListingNotFoundError();
    return listing;
  }

  private async withRetry<T>(
    operation: "detail" | "list",
    requestId: string,
    listingSlug: string | null,
    callback: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await callback();
      } catch (error) {
        const code = sqlState(error);
        const retryable = isTransientPostgresError(error);
        if (!retryable || attempt === this.maxAttempts) {
          this.logger.error(
            { attempt, errorCode: code, event: "listings.read.failed", listingSlug,
              maxAttempts: this.maxAttempts, operation, requestId, retryable },
            "Catalog database read failed",
          );
          throw new ListingsUnavailableError();
        }

        const delayMs = Math.round(
          this.baseDelayMs * 2 ** (attempt - 1) * (0.75 + this.random() * 0.5),
        );
        this.logger.warn(
          { attempt, delayMs, errorCode: code, event: "listings.read.retry",
            listingSlug, maxAttempts: this.maxAttempts, operation, requestId },
          "Retrying transient catalog database read",
        );
        await this.delay(delayMs);
      }
    }
    throw new ListingsUnavailableError();
  }
}
