import fs from "node:fs";

// Resolves a cloud provider's key from one of three sources, at use time —
// never persisted to the config file except by reference (see ./config).
// Never logs or echoes the resolved secret.

export type KeySource =
  | { type: "inline"; key: string }
  | { type: "env"; name: string }
  | { type: "file"; path: string };

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FILE_BYTES = 8 * 1024;

export interface ResolvedKey {
  key?: string;
  error?: string;
}

function isAbsolutePath(p: string): boolean {
  // POSIX absolute ("/...") or Windows absolute ("C:\..." / "C:/...").
  return /^(\/|[a-zA-Z]:[\\/])/.test(p);
}

let fileCache: { path: string; mtimeMs: number; content: string } | null = null;

function readKeyFile(filePath: string): { content?: string; error?: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { error: `Couldn't read ${filePath}` };
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    return { error: `Couldn't read ${filePath}` };
  }
  if (fileCache && fileCache.path === filePath && fileCache.mtimeMs === stat.mtimeMs) {
    return { content: fileCache.content };
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    fileCache = { path: filePath, mtimeMs: stat.mtimeMs, content };
    return { content };
  } catch {
    return { error: `Couldn't read ${filePath}` };
  }
}

/**
 * Resolves a key source to its secret value. `isValid` is optional and only
 * used to pick the right line out of a multi-line file — format errors on the
 * resolved value are the caller's job (provider.isKeyValid).
 */
export function resolveKeySource(source: KeySource, isValid?: (key: string) => boolean): ResolvedKey {
  if (source.type === "inline") {
    return source.key ? { key: source.key } : { error: "No key provided." };
  }

  if (source.type === "env") {
    if (!ENV_NAME_PATTERN.test(source.name)) {
      return { error: `"${source.name}" isn't a valid environment variable name.` };
    }
    const value = process.env[source.name];
    if (!value) return { error: `Variable ${source.name} isn't set.` };
    return { key: value };
  }

  // file
  if (!source.path || !isAbsolutePath(source.path)) {
    return { error: `Couldn't read ${source.path || ""}` };
  }
  const { content, error } = readKeyFile(source.path);
  if (error) return { error };

  const lines = (content ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { error: `Couldn't read ${source.path}` };
  if (lines.length === 1) return { key: lines[0] };

  const match = isValid ? lines.find((l) => isValid(l)) : undefined;
  return { key: match ?? lines[0] };
}

/** Test-only: drop the file-read cache so the next resolve re-stats the file. */
export function resetKeySourceCache(): void {
  fileCache = null;
}
