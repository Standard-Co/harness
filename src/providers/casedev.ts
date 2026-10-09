// case.dev as a pi-ai provider: one OpenAI-compatible endpoint whose catalog
// carries each model's real context window, output cap, and input modalities.

import { createProvider, envApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const CASEDEV_PROVIDER = "casedev";
const DEFAULT_BASE_URL = "https://api.case.dev/llm/v1";

interface CatalogModel {
	id: string;
	context_window?: number;
	max_tokens?: number;
	modalities?: { input?: string[] };
}

function toModel(entry: CatalogModel, baseUrl: string): Model<"openai-completions"> | undefined {
	if (!entry.context_window || !entry.max_tokens) return undefined; // embeddings and the like
	const input: ("text" | "image")[] = ["text"];
	if (entry.modalities?.input?.includes("image")) input.push("image");
	return {
		id: entry.id,
		name: entry.id,
		api: "openai-completions",
		provider: CASEDEV_PROVIDER,
		baseUrl,
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.context_window,
		maxTokens: entry.max_tokens,
	};
}

export function casedevProvider(options: { baseUrl?: string } = {}): Provider {
	const baseUrl = (options.baseUrl ?? process.env.CASEDEV_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	return createProvider({
		id: CASEDEV_PROVIDER,
		name: "case.dev",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("case.dev API key", ["CASEDEV_API_KEY", "CASE_API_KEY"]) },
		models: [],
		fetchModels: async ({ signal, credential }) => {
			const apiKey = credential?.type === "api_key" ? credential.key : undefined;
			const response = await fetch(`${baseUrl}/models`, {
				headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
				signal,
			});
			if (!response.ok) throw new Error(`case.dev catalog: HTTP ${response.status}`);
			const body = (await response.json()) as { data?: CatalogModel[] } | CatalogModel[];
			const entries = Array.isArray(body) ? body : (body.data ?? []);
			return entries.flatMap((entry) => {
				const model = toModel(entry, baseUrl);
				return model === undefined ? [] : [model];
			});
		},
		api: openAICompletionsApi(),
	});
}
