import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { SecretEntry } from "./obfuscator";

/** Resume-state file basename, written under the global agent dir. */
const STATE_BASENAME = "fix-refusal-state.json";
/** Resume state older than this is ignored (and cleared) — stale discovery from an abandoned run. */
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** In-progress /fix-refusal discovery, persisted so a run interrupted by a provider outage or settings change can resume. */
export interface FixRefusalState {
	/** Session that produced the partial run; resume only matches the same session. */
	sessionId: string;
	/** Patterns discovered so far. */
	entries: SecretEntry[];
	/** The refusal text the run was clearing (diagnostics only). */
	refusalText?: string;
	/** Epoch ms of the last update. */
	updatedAt: number;
}

function statePath(agentDir: string): string {
	return path.join(agentDir, STATE_BASENAME);
}

/** Load resume state, or null when absent/corrupt/stale (stale is also cleared). */
export async function loadFixRefusalState(agentDir: string): Promise<FixRefusalState | null> {
	let raw: unknown;
	try {
		raw = await Bun.file(statePath(agentDir)).json();
	} catch (err) {
		if (isEnoent(err)) return null;
		return null; // corrupt JSON -> treat as no resume state
	}
	if (!isValidState(raw)) return null;
	if (Date.now() - raw.updatedAt > STATE_TTL_MS) {
		await clearFixRefusalState(agentDir);
		return null;
	}
	return raw;
}

export async function saveFixRefusalState(agentDir: string, state: FixRefusalState): Promise<void> {
	await Bun.write(statePath(agentDir), JSON.stringify(state, null, 2));
}

export async function clearFixRefusalState(agentDir: string): Promise<void> {
	await fs.rm(statePath(agentDir), { force: true });
}

function isValidState(value: unknown): value is FixRefusalState {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record.sessionId !== "string" || typeof record.updatedAt !== "number") return false;
	if (!Array.isArray(record.entries)) return false;
	return record.entries.every(
		entry => !!entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).content === "string",
	);
}
