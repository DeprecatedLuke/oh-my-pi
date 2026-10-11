/**
 * OpenCode Console sign-in wire contract.
 *
 * `opencode-go` / `opencode-zen` accept two credential shapes:
 * - a plain API key (legacy Zen/Go key or Console service-account key), sent
 *   to the bundled `https://opencode.ai/zen/...` endpoints;
 * - an OpenCode Console device-flow token, persisted as OAuth and surfaced as
 *   the structured API key `{"token":…,"apiEndpoint":…}` (`api-key-format
 *   "structured"`). Console user tokens authenticate only against the Console
 *   inference gateway (`https://opencode.ai/inference/...`), bound to the
 *   workspace chosen during sign-in, and always as `Authorization: Bearer`.
 *
 * The gateway root (`apiEndpoint`) is pinned per provider by the auth rule's
 * credential map; this module only appends the per-protocol path.
 */

/** OpenCode Console device-flow credential decoded from a structured API key. */
export interface OpenCodeConsoleCredential {
	/** Console access token, sent as `Authorization: Bearer`. */
	token: string;
	/** Console inference gateway root, e.g. `https://opencode.ai/inference/go`. */
	apiEndpoint: string;
}

/**
 * Decode a structured OpenCode Console credential. Returns `null` for plain
 * API keys (anything that is not a JSON object carrying both `token` and
 * `apiEndpoint`), which keep the bundled Zen/Go routing.
 */
export function parseOpenCodeConsoleCredential(apiKey: string | undefined): OpenCodeConsoleCredential | null {
	const trimmed = apiKey?.trim();
	if (!trimmed?.startsWith("{")) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { token, apiEndpoint } = parsed as { token?: unknown; apiEndpoint?: unknown };
	if (typeof token !== "string" || typeof apiEndpoint !== "string") return null;
	const normalizedToken = token.trim();
	const normalizedEndpoint = apiEndpoint.trim().replace(/\/+$/, "");
	if (!normalizedToken || !normalizedEndpoint) return null;
	return { token: normalizedToken, apiEndpoint: normalizedEndpoint };
}

/**
 * Base URL on the Console inference gateway for one wire protocol, matching
 * how each transport appends its own path:
 * - OpenAI Chat Completions / Responses → `{root}/openai/v1`
 * - Anthropic Messages (SDK appends `/v1/messages`) → `{root}/anthropic`
 * - Gemini (`{base}/models/{id}:…`) → `{root}/google/v1beta`
 *
 * Returns `undefined` for protocols the gateway does not serve.
 */
export function resolveOpenCodeConsoleBaseUrl(api: string, apiEndpoint: string): string | undefined {
	const root = apiEndpoint.replace(/\/+$/, "");
	switch (api) {
		case "openai-completions":
		case "openai-responses":
			return `${root}/openai/v1`;
		case "anthropic-messages":
			return `${root}/anthropic`;
		case "google-generative-ai":
			return `${root}/google/v1beta`;
		default:
			return undefined;
	}
}
