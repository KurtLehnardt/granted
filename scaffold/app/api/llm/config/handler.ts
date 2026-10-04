import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { readLlmConfig, writeLlmConfig, publicKeySource, resolveCloudConfig, type LlmConfigFile } from "@/lib/llm/config";
import { validateCloudConfig } from "@/lib/llm/validateCloudConfig";
import { buildLocalEmbeddingsStatus, shouldAutoStart, type LocalEmbeddingsStatus } from "@/lib/embeddings/localEmbeddings";
import { startLocalEmbeddingsJob } from "@/lib/embeddings/startLocalEmbeddings";

// POST /api/llm/config — Settings Local/Cloud switch write path. Loopback-only
// (writes a plaintext key, or a key reference, to disk). Never logs the key.
// Cloud is only committed with a resolvable, format-valid key (see validateCloudConfig).
// Switching to Local also starts the background local-search setup when it's needed
// (lib/embeddings/localEmbeddings.ts), so the user never has to re-embed by hand.

export type LlmConfigDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  readLlmConfig: typeof readLlmConfig;
  writeLlmConfig: typeof writeLlmConfig;
  localEmbeddingsStatus: () => LocalEmbeddingsStatus | null;
  startLocalEmbeddings: () => void;
};

// Under node:test with no isolated dir, never touch the real data/local/ or spawn a job.
const localEmbeddingsIsolated = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR;

const REAL_DEPS: LlmConfigDeps = {
  isLoopbackRequest,
  readLlmConfig,
  writeLlmConfig,
  localEmbeddingsStatus: () => (localEmbeddingsIsolated() ? null : buildLocalEmbeddingsStatus()),
  startLocalEmbeddings: () => {
    if (!localEmbeddingsIsolated()) startLocalEmbeddingsJob();
  },
};

/**
 * After a switch to Local: start the local-search setup if it has work to do. Never fails
 * the switch itself. Builds the status once; a just-started job is reported as running
 * (its "checking" stage) rather than re-reading everything from disk.
 */
function autoStartLocalEmbeddings(d: LlmConfigDeps): LocalEmbeddingsStatus | undefined {
  try {
    const status = d.localEmbeddingsStatus();
    if (!status) return undefined;
    if (!shouldAutoStart(status, "ollama")) return status;
    d.startLocalEmbeddings();
    const { error: _e, errorKind: _k, ...rest } = status;
    return { ...rest, state: "running", progress: { stage: "checking" } };
  } catch {
    return undefined; // Settings shows the status (and a Retry) from GET /api/llm/embeddings
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
    const localEmbeddings = autoStartLocalEmbeddings(d);
    return NextResponse.json({ provider: saved.provider ?? "ollama", ...(localEmbeddings ? { localEmbeddings } : {}) });
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
