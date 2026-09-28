import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { readLlmConfig, writeLlmConfig, publicKeySource, resolveCloudConfig, type LlmConfigFile } from "@/lib/llm/config";
import { validateCloudConfig } from "@/lib/llm/validateCloudConfig";

// POST /api/llm/config — Settings Local/Cloud switch write path. Loopback-only
// (writes a plaintext key, or a key reference, to disk). Never logs the key.
// Cloud is only committed with a resolvable, format-valid key (see validateCloudConfig).

export type LlmConfigDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  readLlmConfig: typeof readLlmConfig;
  writeLlmConfig: typeof writeLlmConfig;
};

const REAL_DEPS: LlmConfigDeps = { isLoopbackRequest, readLlmConfig, writeLlmConfig };

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
    return NextResponse.json({ provider: saved.provider ?? "ollama" });
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
