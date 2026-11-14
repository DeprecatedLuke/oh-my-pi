/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { effect, register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────────────

// Secret handling
export const cfgSecretsEnabled = register({
	id: "secrets.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Hide Secrets",
		description: "Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers",
	},
});
// Process-wide fallback for requests outside a session; a session's own requests redact per its
// settings (`withCredentialRedaction` in `sdk.ts`), whichever instance holds the effects.
effect(cfgSecretsEnabled, configureCredentialRedaction);

/** Model glob → secrets file path(s); see {@link cfgSecretsModelFiles}. */
export type SecretsModelFiles = Record<string, string | readonly string[]>;
const EMPTY_SECRETS_MODEL_FILES: SecretsModelFiles = {};

export const cfgSecretsModelFiles = register({
	id: "secrets.modelFiles",
	type: "record",
	default: EMPTY_SECRETS_MODEL_FILES,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Per-Model Secrets Files",
		description:
			'JSON object mapping a model glob to the secrets file(s) used for that model INSTEAD of the global agent-dir secrets.yml and secrets-managed.yml, e.g. {"*opus-*":"~/.omp/agent/secrets-anthropic.yml","openai-codex/*":[]}. Keys match the model id, or "provider/model-id" when the key contains "/"; "*" is the only wildcard; an exact key beats a glob and the longest literal part wins. Relative paths resolve against the agent dir. Environment, dotenv, project .omp/secrets*.yml and built-in patterns still apply.',
	},
});
