const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export function validateOrderLookupBaseUrl(value: string, nodeEnv: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ORDER_LOOKUP_BASE_URL must be an absolute URL.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "ORDER_LOOKUP_BASE_URL must not contain credentials, a query, or a fragment.",
    );
  }
  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("ORDER_LOOKUP_BASE_URL must use HTTPS in production.");
  }
  if (
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    !loopbackHosts.has(url.hostname)
  ) {
    throw new Error(
      "ORDER_LOOKUP_BASE_URL may use HTTP only with a loopback host outside production.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("ORDER_LOOKUP_BASE_URL must use HTTP or HTTPS.");
  }
  return url;
}

export function buildOrderLookupUrl(value: string, nodeEnv = "development") {
  const url = validateOrderLookupBaseUrl(value, nodeEnv);
  url.pathname = "/orders";
  url.search = "";
  url.hash = "";
  return url.toString();
}
