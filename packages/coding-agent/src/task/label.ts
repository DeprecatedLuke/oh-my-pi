/**
 * Tiny-model UI labels for spawned subagents.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import taskLabelSystemPrompt from "../prompts/system/task-label.md" with { type: "text" };
import { generateSessionTitle } from "../utils/title-generator";

const TASK_LABEL_SYSTEM_PROMPT = prompt.render(taskLabelSystemPrompt);

/** True when a generated label is just the spawn handle, including `Name-2`. */
export function labelEchoesHandle(handle: string | undefined, label: string): boolean {
	if (!handle) return false;
	if (label.localeCompare(handle, undefined, { sensitivity: "accent" }) === 0) return true;
	const separator = handle.lastIndexOf("-");
	if (separator <= 0) return false;
	const prefix = handle.slice(0, separator);
	const suffix = handle.slice(separator + 1);
	return /^\d+$/.test(suffix) && prefix.localeCompare(label, undefined, { sensitivity: "accent" }) === 0;
}

/** Session accessors the label request needs; both redactors are absent when the session has no configured secrets. */
export interface TaskLabelOptions {
	/** Spawn handle, used to reject labels that merely repeat the id. */
	sessionId?: string;
	signal?: AbortSignal;
	/** Redacts configured secrets from the assignment before the label model sees it. */
	obfuscate?: (text: string) => string;
	/** Restores placeholders the label model echoed, so the UI shows real values instead of tokens. */
	deobfuscate?: (text: string) => string;
}

/** Compresses a delegated assignment into a one-sentence UI label via the tiny title model — fired by the executor spawn path because the task wire schema no longer carries a `description`; null on empty input or failure. */
export async function generateTaskLabel(
	assignment: string,
	registry: ModelRegistry,
	settings: Settings,
	options: TaskLabelOptions = {},
): Promise<string | null> {
	const text = assignment.trim();
	if (!text) return null;
	try {
		const label = await generateSessionTitle(
			options.obfuscate?.(text) ?? text,
			registry,
			settings,
			options.sessionId,
			undefined,
			undefined,
			TASK_LABEL_SYSTEM_PROMPT,
			options.signal,
		);
		if (!label || labelEchoesHandle(options.sessionId, label)) return null;
		return options.deobfuscate?.(label) ?? label;
	} catch (err) {
		logger.debug("task-label: generation failed", {
			titleSessionId: options.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
