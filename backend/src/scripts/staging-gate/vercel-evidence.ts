import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const FORBIDDEN_KEYS = /(authorization|bypass|credential|password|rawMarker|secret|token)/i;

function assertRedacted(value: unknown, path = "root"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`Evidence contains forbidden field at ${path}.${key}.`);
    assertRedacted(child, `${path}.${key}`);
  }
}

export async function writeAtomicJson(path: string, value: unknown) {
  assertRedacted(value);
  const directory = dirname(path);
  const temporary = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (!(error instanceof Error) || !/EINVAL|EPERM/.test(error.message)) throw error;
  }
  return readJsonFile(path);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const source = await readFile(path, "utf8");
  const parsed = JSON.parse(source) as T;
  assertRedacted(parsed);
  return parsed;
}

