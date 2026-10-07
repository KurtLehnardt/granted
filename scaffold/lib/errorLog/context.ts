/**
 * The non-secret facts a problem report carries: version, OS, which KIND of
 * model provider is in use (never a key, never a base URL) and which
 * embeddings search uses. Server-only; never throws.
 */
import { appVersion } from "../appUpdate/install";
import { resolveCloudConfig, resolveProvider } from "../llm/config";
import { activeSearchSpace } from "../embeddings/spaces";
import type { IssueContext } from "./issueUrl";
import { platformLabel } from "./server";

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function providerLabel(): string {
  return safe(() => {
    if (resolveProvider() === "ollama") return "local (Ollama)";
    const cloud = resolveCloudConfig();
    return cloud ? `cloud (${cloud.providerId})` : "cloud (not set up)";
  }, "unknown");
}

export function issueContext(): IssueContext {
  return {
    version: safe(() => appVersion(), "unknown"),
    os: platformLabel(),
    provider: providerLabel(),
    searchMode: safe(() => activeSearchSpace().space.id, "unknown"),
  };
}
