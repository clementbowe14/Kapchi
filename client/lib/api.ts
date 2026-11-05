export function buildApiUrl(path: string) {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (baseUrl) {
    return `${baseUrl}${normalizedPath}`;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is required in production.");
  }

  if (process.env.NODE_ENV === "test") {
    return `/api${normalizedPath}`;
  }

  return `http://localhost:${process.env.NEXT_PUBLIC_BACKEND_PORT ?? "4000"}${normalizedPath}`;
}
