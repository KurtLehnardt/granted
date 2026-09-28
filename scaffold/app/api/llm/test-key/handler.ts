import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { resolveCloudConfig, resolveCloudModel, isValidAnthropicWorkspaceId } from "@/lib/llm/config";
import { isCloudProviderId, isValidHttpsUrl } from "@/lib/llm/providers";
import { normalizeOpenAiBaseUrl } from "@/lib/llm/baseUrl";
import { resolveDraftKey, savedKeySourceFor } from "@/lib/llm/validateCloudConfig";
import { probeCloudKey } from "@/lib/llm/cloudModels";
import { MODEL } from "@/lib/claude";

// POST /api/llm/test-key — "Test key" button, every cloud provider. Loopback-only
// (spends real credit / hits the provider). Accepts either a draft (not-yet-saved)
// {providerId, baseUrl?, keySource, model?} or, with no body, tests the saved config.
// Never echoes the key.

export type TestKeyDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  resolveCloudConfig: typeof resolveCloudConfig;
  probeCloudKey: typeof probeCloudKey;
};

const REAL_DEPS: TestKeyDeps = { isLoopbackRequest, resolveCloudConfig, probeCloudKey };

export async function handleTestKeyPost(
  req: { headers: { get(name: string): string | null }; json: () => Promise<unknown> },
  deps: Partial<TestKeyDeps> = {},
): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ ok: false, error: "This setting is only available from localhost." }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* no body -> test the saved config */
  }

  let providerId: unknown;
  let baseUrl: string | undefined;
  let keySourceInput: unknown;
  let model: string | undefined;
  let anthropicWorkspaceId: string | undefined;
  let saved: ReturnType<typeof savedKeySourceFor>;

  if (body?.providerId !== undefined || body?.keySource !== undefined) {
    providerId = body.providerId;
    if (!isCloudProviderId(providerId)) {
      return NextResponse.json({ ok: false, error: "Choose a cloud provider." }, { status: 400 });
    }
    if (providerId === "other") {
      baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      if (!baseUrl) return NextResponse.json({ ok: false, error: "Enter a base URL for this provider." }, { status: 400 });
      if (!isValidHttpsUrl(baseUrl)) {
        return NextResponse.json({ ok: false, error: "Enter a valid https base URL." }, { status: 400 });
      }
      baseUrl = normalizeOpenAiBaseUrl(baseUrl);
    }
    keySourceInput = body.keySource;
    model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    saved = savedKeySourceFor(d.resolveCloudConfig(), providerId, baseUrl);
    if (providerId === "anthropic" && typeof body.anthropicWorkspaceId === "string" && body.anthropicWorkspaceId.trim()) {
      const trimmed = body.anthropicWorkspaceId.trim();
      if (!isValidAnthropicWorkspaceId(trimmed)) {
        return NextResponse.json({ ok: false, error: 'That doesn\'t look like a valid Workspace ID (it should look like "wrkspc_...").' }, { status: 400 });
      }
      anthropicWorkspaceId = trimmed;
    }
  } else {
    const cfg = d.resolveCloudConfig();
    if (!cfg) return NextResponse.json({ ok: false, error: "No cloud key saved or provided." }, { status: 400 });
    providerId = cfg.providerId;
    baseUrl = cfg.baseUrl;
    keySourceInput = cfg.keySource;
    model = resolveCloudModel(cfg);
    anthropicWorkspaceId = cfg.anthropicWorkspaceId;
  }

  const draft = resolveDraftKey(providerId as any, keySourceInput, saved);
  if (draft.error) return NextResponse.json({ ok: false, error: draft.error }, { status: 400 });

  // Anthropic searches run on MODEL unless one is configured, so probe that;
  // other providers resolve their own default inside probeCloudKey.
  const outcome = await d.probeCloudKey({
    providerId: providerId as any,
    baseUrl,
    key: draft.key!,
    model: model ?? (providerId === "anthropic" ? MODEL : undefined),
    anthropicWorkspaceId,
  });
  if (outcome.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, error: outcome.message });
}
