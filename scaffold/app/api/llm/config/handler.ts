import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { readLlmConfig, writeLlmConfig, publicKeySource, resolveCloudConfig, type LlmConfigFile } from "@/lib/llm/config";
import { validateCloudConfig } from "@/lib/llm/validateCloudConfig";
import { buildSearchStatus, type SearchStatus } from "@/lib/embeddings/searchStatus";
import { startBuiltinModelDownload } from "@/lib/embeddings/builtin";

// POST /api/llm/config — Settings Local/Cloud switch write path. Loopback-only
// (writes a plaintext key, or a key reference, to disk). Never logs the key.
// Cloud is only committed with a resolvable, format-valid key (see validateCloudConfig).
// On Local, search uses the built-in model and its shipped corpus vectors (the same
// vectors Ollama's nomic-embed-text produces), so there is nothing to re-embed: a
// switch to Local only makes sure the model files are downloaded.

export type LlmConfigDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  readLlmConfig: typeof readLlmConfig;
  writeLlmConfig: typeof writeLlmConfig;
  searchStatus: () => SearchStatus | null;
  startModelDownload: () => void;
};

// Under node:test, never start a real download.
const isolated = () => Boolean(process.env.NODE_TEST_CONTEXT);

const REAL_DEPS: LlmConfigDeps = {
  isLoopbackRequest,
  readLlmConfig,
  writeLlmConfig,
  searchStatus: () => (isolated() ? null : buildSearchStatus()),
  startModelDownload: () => {
    if (!isolated()) startBuiltinModelDownload();
  },
};

/**
 * After a switch to Local: download the built-in search model now if it isn't on
 * disk yet, so the first search doesn't wait for it. Never fails the switch itself.
 */
function prepareBuiltinSearch(d: LlmConfigDeps): SearchStatus | undefined {
  try {
    const status = d.searchStatus();
    if (!status) return undefined;
    if (status.space !== "builtin" || (status.builtin.state !== "missing" && status.builtin.state !== "failed")) return status;
    d.startModelDownload();
    return { ...status, builtin: { ...status.builtin, state: "downloading", pct: 0, error: undefined } };
  } catch {
    return undefined; // Settings reads the status from GET /api/llm/embeddings
  }
}

export async function handleLlmConfigPost(
  req: { headers: { get(name: string): string | null }; json: () => Promise<unknown> },
  deps: Partial<LlmConfigDeps> = {},
): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "This setting is only available from localhost." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const provider: unknown = body?.provider;
  if (provider !== "ollama" && provider !== "cloud") {
    return NextResponse.json({ error: 'provider must be "ollama" or "cloud".' }, { status: 400 });
  }

  if (provider === "ollama") {
    const patch: LlmConfigFile = { provider: "ollama", anthropicApiKey: undefined };
    if (body?.clearCloud === true) patch.cloud = undefined;
    const saved = d.writeLlmConfig(patch);
    const search = prepareBuiltinSearch(d);
    return NextResponse.json({ provider: saved.provider ?? "ollama", ...(search ? { search } : {}) });
  }

  const { config, error } = validateCloudConfig(body?.cloud ?? {}, resolveCloudConfig(d.readLlmConfig()));
  if (error) return NextResponse.json({ error }, { status: 400 });

  // A fresh cloud save always supersedes #210's legacy plaintext field.
  const saved = d.writeLlmConfig({ provider: "cloud", cloud: config, anthropicApiKey: undefined });
  const savedCloud = saved.cloud!;
  return NextResponse.json({
    provider: "cloud",
    cloud: {
      providerId: savedCloud.providerId,
      ...(savedCloud.baseUrl ? { baseUrl: savedCloud.baseUrl } : {}),
      ...(savedCloud.model ? { model: savedCloud.model } : {}),
      keySource: publicKeySource(savedCloud.keySource),
    },
  });
}
