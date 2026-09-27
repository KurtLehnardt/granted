/** LLM backend info surfaced to the client via /api/match's "start" progress
 *  event and /api/llm. `model`/`paramsB` are local-only (undefined when hosted
 *  or when Ollama's `/api/tags` lookup failed/timed out). */
export type LlmInfo = {
  local: boolean;
  model?: string;
  paramsB?: number;
};
