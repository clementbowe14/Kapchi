export function buildApiUrl(path: string) {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (baseUrl) {
    return `${baseUrl}${normalizedPath}`;
  }

  return normalizedPath.startsWith("/api/")
    ? normalizedPath
    : `/api${normalizedPath}`;
}
