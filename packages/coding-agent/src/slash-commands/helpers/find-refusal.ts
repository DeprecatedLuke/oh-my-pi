import { type AgentMessage, instrumentedCompleteSimple } from "@oh-my-pi/pi-agent-core";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { InteractiveModeContext } from "../../modes/types";
import { ansiTextRows } from "../../ui/transcript/ansi-text";
import { YAML } from "bun";
import { clearFindRefusalState, loadFindRefusalState, type SecretEntry, saveFindRefusalState } from "../../secrets";
import {
	classifierRefusalText,
	FindRefusalAbort,
	type FindRefusalComplete,
	type FindRefusalResult,
	runFindRefusal,
} from "../../secrets/find-refusal";

/** Progress sink so the orchestrator renders identically in TUI and ACP modes. */
export interface FindRefusalUi {
	/** Append a visible progress line. */
	step(line: string): void;
	/** Set (or clear) the working/spinner message. */
	working(message?: string): void;
}

/** TUI progress sink with a final cleanup hook. */
export interface TuiFindRefusalUi extends FindRefusalUi {
	done(): void;
}

export interface FindRefusalDeps {
	session: InteractiveModeContext["session"];
	settings: Settings;
	signal?: AbortSignal;
	ui: FindRefusalUi;
}

/**
 * The uncensored model pattern for /find-refusal: the configured `uncensored`
 * model role, or undefined when it is not set. /find-refusal takes no model
 * argument and has no dedicated setting — the role is the single source.
 */
export function resolveRefusalModelPattern(settings: Settings): string | undefined {
	return settings.getModelRole("uncensored")?.trim() || undefined;
}

/**
 * Render discovered patterns as ready-to-paste `secrets.yml` entries (a YAML
 * array). Optional fields are omitted when empty, matching what the secrets
 * loader accepts.
 */
export function formatPatternsYaml(entries: readonly SecretEntry[]): string {
	const records = entries.map(entry => {
		const record: Record<string, unknown> = {
			type: entry.type,
			content: entry.content,
			mode: entry.mode ?? "obfuscate",
		};
		if (entry.flags) record.flags = entry.flags;
		if (entry.friendlyName) record.friendlyName = entry.friendlyName;
		if (entry.replacement) record.replacement = entry.replacement;
		return record;
	});
	return YAML.stringify(records, null, 2).trimEnd();
}

/**
 * Resolve models, replay the session context to {@link runFindRefusal}, then
 * print the resulting patterns as `secrets.yml` YAML. Nothing is written to
 * disk, no session state changes, and the prompt is not re-sent.
 */
export async function executeFindRefusal(deps: FindRefusalDeps): Promise<void> {
	const { session, settings, signal, ui } = deps;
	const registry = session.modelRegistry;

	const mainModel = session.model;
	if (!mainModel) {
		ui.step("No active model — nothing to find a refusal for.");
		return;
	}

	const available = registry.getAvailable();
	if (available.length === 0) {
		ui.step("No models are available.");
		return;
	}

	const pattern = resolveRefusalModelPattern(settings);
	if (!pattern) {
		ui.step(
			"No uncensored model configured for /find-refusal. Set the `uncensored` model role via the model-role selector.",
		);
		return;
	}

	const uncensoredModel = resolveModelFromString(
		expandRoleAlias(pattern, settings),
		available,
		getModelMatchPreferences(settings),
	);
	if (!uncensoredModel) {
		ui.step(`Could not resolve refusal-finding model "${pattern}".`);
		return;
	}

	if (!(await registry.getApiKey(mainModel))) {
		ui.step(`No API key for ${formatModelString(mainModel)}.`);
		return;
	}
	if (!(await registry.getApiKey(uncensoredModel))) {
		ui.step(`No API key for ${formatModelString(uncensoredModel)}.`);
		return;
	}

	// Replay the live session context up to (but NOT including) the trailing
	// refusal turn, so the re-probe sees the SAME context the model refused on —
	// crucially the recent tool-call turns and tool results, where a cyber/
	// classifier trigger usually lives — not just the user prompt. Trimming to the
	// user turn alone hid the triggering reads/searches from both the judge (which
	// then saw nothing to mask) and the re-probe (which couldn't reproduce it).
	const sliceEnd = probeSliceEnd(session.messages);
	if (sliceEnd === null) {
		ui.step("No user turn in the conversation to re-test.");
		return;
	}
	const { systemPrompt, messages: probeMessages } = await session.buildSideRequestContext(
		session.messages.slice(0, sliceEnd),
	);
	const refusalText = latestRefusalText(session.messages) ?? "(no textual response)";
	const agentDir = settings.getAgentDir();
	const resumeState = await loadFindRefusalState(agentDir);
	const initialEntries =
		resumeState && resumeState.sessionId === session.sessionId && resumeState.entries.length > 0
			? resumeState.entries
			: undefined;
	if (initialEntries) {
		ui.step(
			`Resuming an interrupted run with ${initialEntries.length} previously discovered pattern${initialEntries.length === 1 ? "" : "s"}.`,
		);
	}

	ui.step(`Using ${formatModelString(uncensoredModel)} to find what made ${formatModelString(mainModel)} refuse.`);

	const complete: FindRefusalComplete = ({ model, context, toolChoice, temperature }) =>
		instrumentedCompleteSimple(
			model,
			context,
			{ apiKey: registry.resolver(model, session.sessionId), signal, toolChoice, temperature },
			{ telemetry: undefined, oneshotKind: "find_refusal" },
		);

	let result: FindRefusalResult;
	try {
		result = await runFindRefusal({
			mainModel,
			uncensoredModel,
			systemPrompt,
			probeMessages,
			refusalText,
			complete,
			signal,
			onStep: line => ui.step(line),
			onWorking: message => ui.working(message),
			initialEntries,
			onProgress: entries =>
				saveFindRefusalState(agentDir, {
					sessionId: session.sessionId,
					entries,
					refusalText,
					updatedAt: Date.now(),
				}),
		});
	} catch (err) {
		if (err instanceof FindRefusalAbort) {
			ui.step("Cancelled.");
			return;
		}
		throw err;
	}

	if (!result.resolved) {
		ui.step(`Could not find the refusal's cause (${result.reason ?? "unknown"}).`);
		return;
	}
	if (result.entries.length === 0) {
		ui.step(
			`${formatModelString(uncensoredModel)} judged the last response a normal answer, not a refusal — nothing to mask. If it was a refusal, set a different model for the \`uncensored\` role and retry.`,
		);
		await clearFindRefusalState(agentDir);
		return;
	}

	const count = result.entries.length;
	ui.step(`Found ${count} pattern${count === 1 ? "" : "s"} behind the refusal. Ready-to-paste secrets.yml entries:`);
	ui.step(formatPatternsYaml(result.entries));
	ui.step(
		"Add them to a project `.omp/secrets.yml`, or to a per-model secrets file listed in the `secrets.modelFiles` setting.",
	);
	await clearFindRefusalState(agentDir);
}

/**
 * The text of the trailing refusal turn. A cyber/classifier refusal stores it in
 * the assistant message's `errorMessage` (stopReason "error"); a plain refusal
 * keeps it in the content text blocks. Returns undefined when the last assistant
 * turn carries neither (e.g. a bare tool-call turn).
 */
function latestRefusalText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const classifier = classifierRefusalText(message);
		if (classifier) return classifier;
		const parts: string[] = [];
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
		return parts.join("\n").trim() || undefined;
	}
	return undefined;
}

/**
 * Exclusive end index for the replayed probe slice: everything up to but NOT
 * including the trailing refusal turn (the last assistant turn after the final
 * user prompt). Keeping the user prompt AND the intervening tool-call turns + tool
 * results — where a cyber classifier's trigger usually lives — lets the judge see
 * the flaggable content and the re-probe reproduce the refusal. Returns null when
 * there is no user turn to re-test.
 */
export function probeSliceEnd(messages: readonly { readonly role: string }[]): number | null {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser < 0) return null;
	for (let i = messages.length - 1; i > lastUser; i--) {
		if (messages[i].role === "assistant") return i;
	}
	return lastUser + 1;
}

/** Elapsed-time suffix for the find-refusal spinner. Empty under 1s (no `· 0s` noise); `14s`; `1m 05s` past a minute. */
export function formatElapsedClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return "";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * Build a live TUI progress block: a single growing dim text panel in the
 * transcript plus a maintenance working row (spinner, elapsed clock, stop
 * control), so the full refusal-finding run stays visible.
 */
export function createTuiFindRefusalUi(ctx: InteractiveModeContext, now: () => number = Date.now): TuiFindRefusalUi {
	const lines = signal<readonly string[]>([]);
	const body = () => {
		const theme = currentTheme();
		return [theme.fg("accent", "Find refusal"), ...lines().map(line => theme.fg("dim", `  ${line}`))].join("\n");
	};
	// Live until `done()`: every `step()` repaints the one panel instead of appending another.
	const panel = ctx.present(
		() => jsx("canvas", { paint: (width: number) => ["", ...ansiTextRows(body(), width, 1)] }),
		{ live: true },
	);
	return {
		step(line: string) {
			lines.set([...lines.peek(), ...line.split("\n")]);
		},
		working(message?: string) {
			if (!message) return;
			const startedAt = now();
			// The row re-reads a function label every frame; a native surface draws its own elapsed clock.
			const label = () => {
				const suffix = ctx.shell.native() ? "" : formatElapsedClock(now() - startedAt);
				return suffix ? `${message} · ${suffix}` : message;
			};
			// Showing the row per phase restarts its clock.
			ctx.showWorking("maintenance", { label, startedAt, interruptKey: ctx.maintenanceInterruptKey() });
		},
		done() {
			ctx.clearWorking("maintenance");
			ctx.shell.transcript.settle(panel);
		},
	};
}
