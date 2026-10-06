import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { getOllamaStatus } from "@/lib/llm/ollamaStatus";
import { installOllama, pullModel, startOllama } from "@/lib/llm/ollamaJobs";
import { isValidModelTag, type OllamaStatus } from "@/lib/llm/ollamaModels";

// GET  /api/llm/ollama — Settings → Model → Local: is Ollama installed / running,
//                        its chat models, what to download, how to install, job progress.
// POST /api/llm/ollama — { action: "start" | "pull" | "install", model? }: start the
//                        daemon, pull a model, or (Windows) install Ollama. Each runs in
//                        the background; the UI polls GET for progress. Loopback-only:
//                        these launch processes and write to disk.

export type OllamaRouteDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  getStatus: () => Promise<OllamaStatus>;
  start: typeof startOllama;
  pull: typeof pullModel;
  install: typeof installOllama;
  platform: NodeJS.Platform;
};

const REAL_DEPS: OllamaRouteDeps = {
  isLoopbackRequest,
  getStatus: () => getOllamaStatus(),
  start: startOllama,
  pull: pullModel,
  install: installOllama,
  platform: process.platform,
};

export async function handleOllamaStatusGet(deps: Partial<OllamaRouteDeps> = {}): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };
  return NextResponse.json(await d.getStatus());
}

export async function handleOllamaActionPost(
  req: { headers: { get(name: string): string | null }; json: () => Promise<unknown> },
  deps: Partial<OllamaRouteDeps> = {},
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

  const status = await d.getStatus();
  switch (body?.action) {
    case "start": {
      if (!status.canManage) {
        return NextResponse.json({ error: `Ollama runs on another computer (${status.host}). Start it there.` }, { status: 400 });
      }
      if (!status.installed) {
        return NextResponse.json({ error: "Ollama isn't installed on this computer yet." }, { status: 400 });
      }
      return NextResponse.json({ job: d.start() }, { status: 202 });
    }
    case "pull": {
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      if (!isValidModelTag(model)) return NextResponse.json({ error: "Enter a model tag, like qwen2.5:7b." }, { status: 400 });
      if (!status.running || !status.isOllama) {
        return NextResponse.json({ error: "Start Ollama first, then download a model." }, { status: 409 });
      }
      const { job, busy } = d.pull(model);
      if (busy) return NextResponse.json({ error: `Already downloading ${busy}. Wait for it to finish.`, job }, { status: 409 });
      return NextResponse.json({ job }, { status: 202 });
    }
    case "install": {
      if (d.platform !== "win32" || !status.canManage) {
        return NextResponse.json(
          { error: `Install Ollama from ${status.install.url} (or run: ${status.install.command}), then check again.` },
          { status: 400 },
        );
      }
      if (status.installed) return NextResponse.json({ error: "Ollama is already installed." }, { status: 409 });
      return NextResponse.json({ job: d.install() }, { status: 202 });
    }
    default:
      return NextResponse.json({ error: 'action must be "start", "pull" or "install".' }, { status: 400 });
  }
}
