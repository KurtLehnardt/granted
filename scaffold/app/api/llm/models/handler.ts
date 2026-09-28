import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { isCloudProviderId, getCloudProvider } from "@/lib/llm/providers";
import { resolveDraftBaseUrl, resolveDraftKey, savedKeySourceFor } from "@/lib/llm/validateCloudConfig";
import { listCloudModels } from "@/lib/llm/cloudModels";
import { resolveCloudConfig } from "@/lib/llm/config";

// POST /api/llm/models — populates the Settings model picker for a cloud
// provider once a key resolves. Loopback-only; never echoes the key.

export type ModelsDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  listCloudModels: typeof listCloudModels;
  resolveCloudConfig: typeof resolveCloudConfig;
};

const REAL_DEPS: ModelsDeps = { isLoopbackRequest, listCloudModels, resolveCloudConfig };

export async function handleModelsPost(
  req: { headers: { get(name: string): string | null }; json: () => Promise<unknown> },
  deps: Partial<ModelsDeps> = {},
): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "This setting is only available from localhost." }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!isCloudProviderId(body?.providerId)) {
    return NextResponse.json({ error: "Choose a cloud provider." }, { status: 400 });
  }
  const providerId = body.providerId;

  const preset = getCloudProvider(providerId)!;
  const { baseUrl, error } = resolveDraftBaseUrl(preset, body.baseUrl);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const saved = savedKeySourceFor(d.resolveCloudConfig(), providerId, baseUrl) ?? preset.defaultKeySource;
  const draft = resolveDraftKey(providerId, body?.keySource, saved);
  if (draft.error) return NextResponse.json({ error: draft.error }, { status: 400 });

  const result = await d.listCloudModels({ providerId, baseUrl, key: draft.key! });
  if (result.error) return NextResponse.json({ error: result.error }, { status: 200 });
  return NextResponse.json({ models: result.models ?? [] });
}
