/**
 * Correlation ids: the short code shown next to an error ("Error ID E-7K3F9Q")
 * and stored with its log entry, so a report can point at the exact entry.
 * Isomorphic: crypto.getRandomValues exists in browsers and in Node 20+.
 */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I: read aloud or retyped without mistakes

export const ERROR_ID_PATTERN = /^E-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

export function newErrorId(): string {
  const bytes = new Uint8Array(6);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let id = "E-";
  for (let i = 0; i < bytes.length; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
  return id;
}

export function isErrorId(value: unknown): value is string {
  return typeof value === "string" && ERROR_ID_PATTERN.test(value);
}
