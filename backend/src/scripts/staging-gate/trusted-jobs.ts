const JOBS = new Set(["health", "inventory", "maintenance", "messages", "refunds"]);

function exactHttpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/") {
    throw new Error("Staging API origin must be an exact HTTPS origin.");
  }
  return url.origin;
}

export async function invokeTrustedJob(input: {
  apiOrigin: string;
  cronSecret: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  operation: string;
}) {
  if (!JOBS.has(input.operation)) throw new Error("Unknown trusted staging job.");
  if (input.cronSecret.length < 16) throw new Error("Cron secret is missing or too short.");
  const origin = exactHttpsOrigin(input.apiOrigin);
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxAttempts = input.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(`${origin}/internal/cron/${input.operation}`, {
      headers: { authorization: `Bearer ${input.cronSecret}` },
      method: "GET",
      redirect: "manual"
    });
    if (
      response.status === 401 &&
      response.headers.get("server")?.toLowerCase() === "vercel" &&
      response.headers.get("content-type")?.toLowerCase().includes("text/html")
    ) {
      throw new Error("The staging API is protected by Vercel instead of Fastify authorization.");
    }
    if (response.status === 200) return { attempts: attempt, operation: input.operation, status: "succeeded" as const };
    if (response.status !== 202 || attempt === maxAttempts) {
      throw new Error(`Trusted staging job failed with HTTP ${response.status}.`);
    }
  }
  throw new Error("Trusted staging job exhausted its bounded attempts.");
}
