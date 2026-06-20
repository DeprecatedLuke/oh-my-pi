import { type AgentMessage, instrumentedCompleteSimple } from "@oh-my-pi/pi-agent-core";
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import {
	appendManagedSecrets,
	clearFixRefusalState,
	collectEnvSecrets,
	loadFixRefusalState,
	loadSecrets,
	SecretObfuscator,
	saveFixRefusalState,
} from "../../secrets";
import {
	classifierRefusalText,
	FixRefusalAbort,
	type FixRefusalComplete,
	type FixRefusalResult,
	runFixRefusal,
} from "../../secrets/fix-refusal";
import { shortenPath } from "../../tools/render-utils";

/** Progress sink so the orchestrator renders identically in TUI and ACP modes. */
export interface FixRefusalUi {
	/** Append a visible progress line. */
	step(line: string): void;
	/** Set (or clear) the working/spinner message. */
	working(message?: string): void;
}

/** TUI progress sink with a final cleanup hook. */
export interface TuiFixRefusalUi extends FixRefusalUi {
	done(): void;
}

export interface FixRefusalDeps {
	session: InteractiveModeContext["session"];
	settings: Settings;
	cwd: string;
	signal?: AbortSignal;
	ui: FixRefusalUi;
}

/** Result of an {@link executeFixRefusal} run, so callers can decide whether to re-send the prompt. */
export interface FixRefusalOutcome {
	resolved: boolean;
	/** New patterns written to secrets-managed.yml this run. */
	saved: number;
	/** Patterns now active in the session from this run (resumed + new); 0 when nothing needed masking. */
	patternsActive: number;
}

/**
 * The uncensored model pattern for /fix-refusal: the configured `uncensored`
 * model role, or undefined when it is not set. /fix-refusal takes no model
 * argument and has no dedicated setting — the role is the single source.
 */
export function resolveRefusalModelPattern(settings: Settings): string | undefined {
	return settings.getModelRole("uncensored")?.trim() || undefined;
}

/**
 * Resolve models, replay the session context to {@link runFixRefusal}, then
 * persist the resulting patterns to `secrets-managed.yml` and hot-swap the
 * session obfuscator so they apply without a restart.
 */
export async function executeFixRefusal(deps: FixRefusalDeps): Promise<FixRefusalOutcome> {
	const { session, settings, cwd, signal, ui } = deps;
	const registry = session.modelRegistry;

	const mainModel = session.model;
	if (!mainModel) {
		ui.step("No active model — nothing to fix a refusal for.");
		return { resolved: false, saved: 0, patternsActive: 0 };
	}

	const available = registry.getAvailable();
	if (available.length === 0) {
		ui.step("No models are available.");
		return { resolved: false, saved: 0, patternsActive: 0 };
	}

	const pattern = resolveRefusalModelPattern(settings);
	if (!pattern) {
		ui.step(
			"No uncensored model configured for /fix-refusal. Set the `uncensored` model role via the model-role selector.",
		);
		return { resolved: false, saved: 0, patternsActive: 0 };
	}

	const uncensoredModel = resolveModelFromString(
		expandRoleAlias(pattern, settings),
		available,
		getModelMatchPreferences(settings),
		registry,
	);
	if (!uncensoredModel) {
		ui.step(`Could not resolve refusal-fix model "${pattern}".`);
		return { resolved: false, saved: 0, patternsActive: 0 };
	}

	if (!(await registry.getApiKey(mainModel))) {
		ui.step(`No API key for ${formatModelString(mainModel)}.`);
		return { resolved: false, saved: 0, patternsActive: 0 };
	}
	if (!(await registry.getApiKey(uncensoredModel))) {
		ui.step(`No API key for ${formatModelString(uncensoredModel)}.`);
		return { resolved: false, saved: 0, patternsActive: 0 };
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
		return { resolved: false, saved: 0, patternsActive: 0 };
	}
	const { systemPrompt, messages: probeMessages } = session.buildSideRequestContext(
		session.messages.slice(0, sliceEnd),
	);
	const refusalText = latestRefusalText(session.messages) ?? "(no textual response)";
	const agentDir = settings.getAgentDir();
	const resumeState = await loadFixRefusalState(agentDir);
	const initialEntries =
		resumeState && resumeState.sessionId === session.sessionId && resumeState.entries.length > 0
			? resumeState.entries
			: undefined;
	if (initialEntries) {
		ui.step(
			`Resuming an interrupted run with ${initialEntries.length} previously discovered pattern${initialEntries.length === 1 ? "" : "s"}.`,
		);
	}

	ui.step(`Using ${formatModelString(uncensoredModel)} to clear a refusal from ${formatModelString(mainModel)}.`);

	const complete: FixRefusalComplete = ({ model, context, toolChoice, temperature }) =>
		instrumentedCompleteSimple(
			model,
			context,
			{ apiKey: registry.resolver(model, session.sessionId), signal, toolChoice, temperature },
			{ telemetry: undefined, oneshotKind: "fix_refusal" },
		);

	let result: FixRefusalResult;
	try {
		result = await runFixRefusal({
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
				saveFixRefusalState(agentDir, {
					sessionId: session.sessionId,
					entries,
					refusalText,
					updatedAt: Date.now(),
				}),
		});
	} catch (err) {
		if (err instanceof FixRefusalAbort) {
			ui.step("Cancelled.");
			return { resolved: false, saved: 0, patternsActive: 0 };
		}
		throw err;
	}

	if (!result.resolved) {
		ui.step(`Could not clear the refusal (${result.reason ?? "unknown"}). No patterns saved.`);
		return { resolved: false, saved: 0, patternsActive: 0 };
	}
	if (result.entries.length === 0) {
		ui.step(
			`${formatModelString(uncensoredModel)} judged the last response a normal answer, not a refusal — nothing to mask. If it was a refusal, set a different model for the \`uncensored\` role and retry.`,
		);
		await clearFixRefusalState(agentDir);
		return { resolved: true, saved: 0, patternsActive: 0 };
	}

	const { path: filePath, added } = await appendManagedSecrets(agentDir, result.entries);

	// Rebuild from every source (env + all secrets files) so the new patterns
	// apply to this session immediately.
	const allSecrets = [...collectEnvSecrets(), ...(await loadSecrets(cwd, agentDir))];
	session.setObfuscator(allSecrets.length > 0 ? new SecretObfuscator(allSecrets) : undefined);

	ui.step(
		added === 0
			? `Patterns already present in ${shortenPath(filePath)}; applied to this session.`
			: `Saved ${added} pattern${added === 1 ? "" : "s"} to ${shortenPath(filePath)} and applied them. Re-send your last message to retry.`,
	);
	for (const entry of result.entries) {
		const label = entry.friendlyName ? ` → ${entry.friendlyName}` : "";
		ui.step(`  /${entry.content}/${entry.flags ?? ""}${label}`);
	}
	await clearFixRefusalState(agentDir);
	return { resolved: true, saved: added, patternsActive: result.entries.length };
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

/** Text of the most recent user turn (the prompt that triggered the latest refusal), or undefined. */
export function latestUserPromptText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content.trim() || undefined;
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

/**
 * Build a live TUI progress block: a single growing dim text panel plus a
 * spinner working-message, so the full refusal-fix run stays visible.
 */
export function createTuiFixRefusalUi(ctx: InteractiveModeContext): TuiFixRefusalUi {
	const lines: string[] = [];
	let panel: Text | undefined;
	const render = () => {
		const body = [theme.fg("accent", "Fix refusal"), ...lines.map(line => theme.fg("dim", `  ${line}`))].join("\n");
		if (panel) {
			panel.setText(body);
			ctx.ui.requestRender();
		} else {
			panel = new Text(body, 1, 0);
			ctx.present([new Spacer(1), panel]);
		}
	};
	render();
	return {
		step(line: string) {
			lines.push(line);
			ctx.setWorkingMessage(undefined);
			render();
		},
		working(message?: string) {
			if (!message) return;
			ctx.setWorkingMessage(message);
			ctx.ensureLoadingAnimation();
		},
		done() {
			ctx.setWorkingMessage(undefined);
			ctx.stopLoadingAnimation();
			// stopLoadingAnimation() clears the status container but does not repaint;
			// without this the last spinner frame ("Working…") stays painted forever.
			ctx.ui.requestRender();
		},
	};
}
