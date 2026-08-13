import { scheduler } from "node:timers/promises";
import type { AssistantMessage, Context, Message, Model, Tool, ToolChoice } from "@oh-my-pi/pi-ai";
import { parseRateLimitReason } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";
import { extractTextContent, extractToolCall } from "../commit/utils";
import fixRefusalDiagnoseTemplate from "../prompts/secrets/fix-refusal-diagnose.md" with { type: "text" };
import fixRefusalNameTemplate from "../prompts/secrets/fix-refusal-name.md" with { type: "text" };
import fixRefusalSelectTemplate from "../prompts/secrets/fix-refusal-select.md" with { type: "text" };
import fixRefusalSystemPrompt from "../prompts/secrets/fix-refusal-system.md" with { type: "text" };
import { buildNamedToolChoice } from "../utils/tool-choice";
import { type SecretEntry, SecretObfuscator } from "./obfuscator";
import { PLACEHOLDER_RE } from "./placeholder";
import { compileSecretRegex } from "./regex";

// ═══════════════════════════════════════════════════════════════════════════
// submit_patterns tool
// ═══════════════════════════════════════════════════════════════════════════

/** Name of the single tool the uncensored model is forced to call. */
export const SUBMIT_PATTERNS_TOOL = "submit_patterns";

const patternSchema = z.object({
	regex: z
		.string()
		.min(1)
		.describe(
			"JavaScript regular-expression source matching the exact span(s) that trigger the refusal. Match as narrowly as possible.",
		),
	flags: z
		.string()
		.optional()
		.describe('Optional regex flags, e.g. "i" for case-insensitive. The global flag is added automatically.'),
	friendlyName: z
		.string()
		.optional()
		.describe(
			"Short innocuous label for this pattern. Appears in the visible placeholder, so it must not echo or hint at the sensitive content.",
		),
	reason: z.string().optional().describe("Brief explanation of why this span triggers the refusal."),
});

const submitPatternsSchema = z.object({
	resolved: z
		.boolean()
		.describe(
			"True when the target's latest response is a normal helpful answer (NOT a refusal). When true, return no patterns.",
		),
	patterns: z.array(patternSchema).default([]).describe("Regex patterns to mask. Empty when resolved is true."),
});

/** Parsed `submit_patterns` payload. */
export type SubmitPatternsPayload = z.infer<typeof submitPatternsSchema>;

const submitPatternsTool: Tool = {
	name: SUBMIT_PATTERNS_TOOL,
	description:
		"Report whether the target model's latest response is still a refusal and, if so, propose narrow regex patterns whose masking would remove the trigger.",
	parameters: submitPatternsSchema,
	strict: false,
};

// ═══════════════════════════════════════════════════════════════════════════
// select_removable tool
// ═══════════════════════════════════════════════════════════════════════════

/** Name of the single tool the model is forced to call during model-guided minimization. */
export const SELECT_REMOVABLE_TOOL = "select_removable";

const selectRemovableSchema = z.object({
	remove: z
		.array(z.number().int())
		.default([])
		.describe(
			"1-based indices, into the numbered pattern list shown, of the patterns that are NOT load-bearing and are safe to stop masking. Empty when none are confidently removable.",
		),
	reason: z.string().optional().describe("Brief explanation of why the chosen patterns are not load-bearing."),
});

/** Parsed `select_removable` payload. */
export type SelectRemovablePayload = z.infer<typeof selectRemovableSchema>;

const selectRemovableTool: Tool = {
	name: SELECT_REMOVABLE_TOOL,
	description:
		"Select which of the currently-applied redaction patterns are NOT load-bearing for the refusal and can be safely unmasked, by their 1-based index in the numbered list.",
	parameters: selectRemovableSchema,
	strict: false,
};

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** A single stateless model call. Abstracts api-key resolution / telemetry so the orchestrator stays pure and testable. */
export type FixRefusalComplete = (request: {
	model: Model;
	context: Context;
	toolChoice?: ToolChoice;
	temperature?: number;
}) => Promise<AssistantMessage>;

export interface FixRefusalOptions {
	/** The model that produced the refusal; re-probed after each masking round. */
	mainModel: Model;
	/** The uncensored model that authors the redaction patterns. */
	uncensoredModel: Model;
	/** System prompt blocks for the main re-probe (already secret-obfuscated). */
	systemPrompt: string[];
	/** Conversation to re-probe, ending at the last user turn (already secret-obfuscated). */
	probeMessages: Message[];
	/** The original refusal text that prompted /fix-refusal. */
	refusalText: string;
	/** Stateless completion driver. */
	complete: FixRefusalComplete;
	signal?: AbortSignal;
	/** Max diagnose/re-probe rounds before giving up (default 6). */
	maxIterations?: number;
	/** Visible progress line sink. */
	onStep?: (line: string) => void;
	/** Working/spinner message sink. */
	onWorking?: (message?: string) => void;
	/** Patterns already discovered by a prior (interrupted) run, to resume from. Seeds the working set. */
	initialEntries?: SecretEntry[];
	/** Awaited whenever the discovered entry set CHANGES — grows on a new round, or shrinks when inert resumed patterns are pruned — so the caller can persist resume state. */
	onProgress?: (entries: SecretEntry[]) => void | Promise<void>;
	/** Max retries for a transient provider error (rate limit / overload / 5xx) per call. Default 5. */
	maxTransientRetries?: number;
	/** Sleep between transient retries; injectable for deterministic tests. Default scheduler.wait. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface FixRefusalResult {
	/** Whether the refusal was cleared. */
	resolved: boolean;
	/** Final minimal (and named, when verified) regex entries. Empty when nothing needed masking. */
	entries: SecretEntry[];
	/** Number of diagnose rounds executed. */
	iterations: number;
	/** The final main-model response observed. */
	finalResponse: string;
	/** Why the run did not resolve, when `resolved` is false. */
	reason?: string;
}

/** Thrown when the run is aborted via the provided signal. */
export class FixRefusalAbort extends Error {
	constructor() {
		super("fix-refusal aborted");
		this.name = "FixRefusalAbort";
	}
}

const DEFAULT_MAX_ITERATIONS = 6;

/**
 * Cap on the re-probe VERIFY trials the model-guided pattern minimization may dispatch (one per
 * proposed-removal batch). Memoized re-tests cost no model round-trip, so this bounds DISTINCT
 * expensive evaluations; on exhaustion the still-clearing working set is kept rather than probed
 * further. It also bounds the round count, so a stuck model cannot grind the loop — total select
 * calls stay ≤ verify-rounds + 1.
 */
const MAX_MINIMIZE_TRIALS = 64;

/** Default transient-error retries per model call before giving up. */
const DEFAULT_TRANSIENT_RETRIES = 5;
/** Backoff ceiling between transient retries. */
const TRANSIENT_BACKOFF_CAP_MS = 30_000;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;

/** Provider stream watchdog timeouts (idle / first-event) surface as plain Errors / error-stops; retry them. */
const STREAM_WATCHDOG_RE = /stream (?:stalled|timed out) while waiting/i;

/** A provider error worth retrying in place: rate limit / model overload / 5xx — but NEVER a refusal (the normal iterative case). */
function isTransientProviderError(message: string): boolean {
	if (isRefusalErrorMessage(message)) return false;
	if (STREAM_WATCHDOG_RE.test(message)) return true;
	const reason = parseRateLimitReason(message);
	return reason === "RATE_LIMIT_EXCEEDED" || reason === "MODEL_CAPACITY_EXHAUSTED" || reason === "SERVER_ERROR";
}

/** Capped exponential backoff with jitter for the Nth (0-based) retry. */
function transientBackoffMs(attempt: number): number {
	const base = Math.min(TRANSIENT_BACKOFF_CAP_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** attempt);
	return base + Math.floor(Math.random() * 1_000);
}

/**
 * Drive the refusal-fix loop: ask the uncensored model for redaction patterns,
 * re-probe the main model with the accumulated masks, and repeat until the main
 * model stops refusing. Then shrink the pattern set to the load-bearing minimum
 * and attach verified innocuous friendly names. Returns the resulting regex
 * {@link SecretEntry}s; the caller persists and applies them.
 */
export async function runFixRefusal(options: FixRefusalOptions): Promise<FixRefusalResult> {
	const { mainModel, uncensoredModel, systemPrompt, probeMessages, complete, signal } = options;
	const maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
	const step = (line: string) => options.onStep?.(line);
	const working = (message?: string) => options.onWorking?.(message);

	const maskMessages = (entries: readonly SecretEntry[]): Message[] =>
		entries.length === 0 ? probeMessages : new SecretObfuscator([...entries]).obfuscateObject(probeMessages);

	const maskContext = (entries: SecretEntry[]): Context => {
		if (entries.length === 0) return { systemPrompt, messages: probeMessages, tools: [] };
		const obfuscator = new SecretObfuscator(entries);
		return {
			systemPrompt: obfuscator.obfuscateObject(systemPrompt),
			messages: obfuscator.obfuscateObject(probeMessages),
			tools: [],
		};
	};

	const maxTransientRetries = Math.max(0, options.maxTransientRetries ?? DEFAULT_TRANSIENT_RETRIES);
	const sleep = options.sleep ?? ((ms: number, sig?: AbortSignal) => scheduler.wait(ms, { signal: sig }));

	// Call `complete`, retrying ONLY transient provider failures (rate limit / overload / 5xx) with
	// backoff. A refusal-shaped error or a non-transient error is returned/thrown unchanged so the
	// caller's normal handling runs. On exhaustion the last response/error is surfaced as-is (the run
	// then fails and its discovered patterns persist for resume).
	const completeWithRetry = async (request: Parameters<FixRefusalComplete>[0]): Promise<AssistantMessage> => {
		for (let attempt = 0; ; attempt++) {
			throwIfAborted(signal);
			let transientText: string | undefined;
			try {
				const response = await complete(request);
				if (
					response.stopReason === "error" &&
					response.errorMessage &&
					isTransientProviderError(response.errorMessage)
				) {
					if (attempt >= maxTransientRetries) return response;
					transientText = response.errorMessage;
				} else {
					return response;
				}
			} catch (err) {
				if (signal?.aborted) throw new FixRefusalAbort();
				const message = err instanceof Error ? err.message : String(err);
				if (!isTransientProviderError(message)) throw err;
				if (attempt >= maxTransientRetries) throw err;
				transientText = message;
			}
			const delay = transientBackoffMs(attempt);
			step(
				`Transient provider error (${transientText?.slice(0, 80) ?? "unknown"}); retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxTransientRetries}).`,
			);
			try {
				await sleep(delay, signal);
			} catch (sleepErr) {
				if (signal?.aborted) throw new FixRefusalAbort();
				throw sleepErr;
			}
		}
	};

	// Re-run the refusing model on the masked conversation. Temperature 0 keeps
	// the refusal/compliance decision as deterministic as the provider allows.
	const reprobeMain = async (entries: SecretEntry[]): Promise<{ text: string; structural: boolean }> => {
		throwIfAborted(signal);
		let response: AssistantMessage;
		try {
			response = await completeWithRetry({
				model: mainModel,
				context: maskContext(entries),
				toolChoice: "none",
				temperature: 0,
			});
		} catch (err) {
			// A still-refusing classifier re-probe is the NORMAL iterative case, but
			// the provider THROWS on stopReason "error" (anthropic.ts) with the
			// structured `stopDetails` discarded. Treat a refusal-shaped error as
			// "still refusing" — return its text so the judge proposes more patterns
			// — and only abort on a real abort or a genuine error.
			if (signal?.aborted) throw new FixRefusalAbort();
			const message = err instanceof Error ? err.message : String(err);
			if (isRefusalErrorMessage(message)) return { text: message, structural: true };
			throw err;
		}
		// Some providers RETURN an error-stop classifier refusal instead of throwing;
		// detect it structurally (stopDetails) before assertCompleted would throw.
		const refusal = classifierRefusalText(response);
		if (refusal) return { text: refusal, structural: true };
		assertCompleted(response, "main model");
		return { text: extractTextContent(response), structural: false };
	};

	// Ask the uncensored model to judge `latestResponse` and propose patterns for
	// whatever is still triggering. The transcript shown is masked with `entries`
	// so already-covered spans appear as placeholders.
	const askUncensored = async (latestResponse: string, entries: SecretEntry[]): Promise<SubmitPatternsPayload> => {
		throwIfAborted(signal);
		const instruction = prompt.render(fixRefusalDiagnoseTemplate, {
			transcript: serializeTranscript(maskMessages(entries)),
			latestResponse,
			patterns: entries.map(entry => ({ regex: entry.content, flags: entry.flags ?? "" })),
		});
		const response = await completeWithRetry({
			model: uncensoredModel,
			context: {
				systemPrompt: [prompt.render(fixRefusalSystemPrompt)],
				messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }],
				tools: [submitPatternsTool],
			},
			toolChoice: buildNamedToolChoice(SUBMIT_PATTERNS_TOOL, uncensoredModel) ?? "required",
		});
		assertCompleted(response, "refusal model");
		return parseSubmitPatterns(response);
	};

	// A trial clears iff the main model stops refusing on the masked set. A
	// structural (classifier/error) refusal is a certain "still refusing", so skip
	// the judge call entirely; otherwise the uncensored model's verdict is authoritative.
	// Memoize verdicts by canonical pattern-SET key (see {@link trialKey}) so any repeated verify the
	// model-guided minimization generates — above all the final re-verify of the committed set — costs
	// no extra model round-trip. Keyed by SET, not masked text, because the judge prompt embeds the
	// literal pattern list. (askUncensored may not be temperature 0; caching its verdict by set keeps
	// repeats self-consistent, and every committed set is itself a re-verified hit.)
	const clearsCache = new Map<string, Promise<boolean>>();
	const trialClears = (trial: SecretEntry[]): Promise<boolean> => {
		const cacheKey = trialKey(trial);
		const cached = clearsCache.get(cacheKey);
		if (cached) return cached;
		const pending = (async () => {
			const { text, structural } = await reprobeMain(trial);
			if (structural) return false;
			const verdict = await askUncensored(text, trial);
			return verdict.resolved;
		})();
		clearsCache.set(cacheKey, pending);
		return pending;
	};

	// Model-guided removal proposal for minimization: show the uncensored model the masked transcript
	// and the numbered list of currently-applied patterns, and ask which are NOT load-bearing for this
	// cyber-exploitation refusal (incidental / over-broad terms) and so safe to stop masking. The model
	// only PROPOSES — every proposed removal is verified by a real `trialClears` before it is committed
	// (see {@link minimizeBySelection}) — so a wrong domain guess never breaks clearing. The returned
	// indices are validated (in-range, deduped), mapped back to the kept entries, and capped to `target`;
	// the result is the subset of `kept` to remove.
	const selectRemovals = async (kept: readonly SecretEntry[], target: number): Promise<SecretEntry[]> => {
		throwIfAborted(signal);
		const instruction = prompt.render(fixRefusalSelectTemplate, {
			transcript: serializeTranscript(maskMessages(kept)),
			patterns: kept.map((entry, i) => ({
				index: i + 1,
				regex: entry.content,
				flags: entry.flags ?? "",
				friendlyName: entry.friendlyName,
				reason: undefined,
			})),
			target,
		});
		const response = await completeWithRetry({
			model: uncensoredModel,
			context: {
				systemPrompt: [prompt.render(fixRefusalSystemPrompt)],
				messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }],
				tools: [selectRemovableTool],
			},
			toolChoice: buildNamedToolChoice(SELECT_REMOVABLE_TOOL, uncensoredModel) ?? "required",
		});
		assertCompleted(response, "refusal model");
		// Validate: keep only in-range 1-based indices, dedupe (first occurrence wins), map to entries,
		// and cap to `target`. An invalid / empty proposal yields no removals (minimizeBySelection then
		// stops the loop) — never an out-of-bounds entry.
		const seen = new Set<number>();
		const removals: SecretEntry[] = [];
		for (const index of parseSelectRemovable(response)) {
			if (!Number.isInteger(index) || index < 1 || index > kept.length || seen.has(index)) continue;
			seen.add(index);
			removals.push(kept[index - 1]!);
			if (removals.length >= target) break;
		}
		return removals;
	};

	// ── Diagnose / re-probe loop ──────────────────────────────────────────────
	let entries: SecretEntry[] = options.initialEntries ? [...options.initialEntries] : [];
	// Resume can re-seed patterns discovered for a PRIOR (different) refusal. One
	// that masks nothing in the current re-probe surface (systemPrompt ∪
	// probeMessages) can never be load-bearing here, so drop it now — for free,
	// via a synchronous mask-diff — instead of spending a leave-one-out model
	// round-trip on it during shrink and bloating every round's judge prompt and
	// re-probe masking. (Freshly proposed in-run patterns always match the
	// transcript the judge read, so this only ever sheds stale cross-refusal cruft.)
	if (entries.length > 0) {
		const surface: [string[], Message[]] = [systemPrompt, probeMessages];
		const baseline = JSON.stringify(surface);
		const active = entries.filter(
			entry => JSON.stringify(new SecretObfuscator([entry]).obfuscateObject(surface)) !== baseline,
		);
		if (active.length < entries.length) {
			step(
				`Pruned ${plural(entries.length - active.length, "inert resumed pattern")} (no match in this conversation).`,
			);
			entries = active;
			await options.onProgress?.(entries);
		}
	}
	let latest = options.refusalText;
	let iterations = 0;
	let resolved = false;
	let lastReprobe: string | undefined;
	step(`Refusal: ${preview(options.refusalText, 200)}`);

	for (; iterations < maxIterations; iterations++) {
		working(`Analyzing the refusal (round ${iterations + 1})…`);
		const verdict = await askUncensored(latest, entries);
		if (verdict.resolved) {
			resolved = true;
			break;
		}
		step(
			iterations === 0
				? "Refusal model confirmed a refusal; proposing masks."
				: "Refusal model still flags the response after the last round; proposing more masks.",
		);
		const reasoned = verdict.patterns.filter(p => p.reason?.trim());
		const REASON_PREVIEW_CAP = 8;
		for (const p of reasoned.slice(0, REASON_PREVIEW_CAP)) {
			step(`  \u21b3 /${p.regex}/${p.flags ?? ""} \u2014 ${preview(p.reason ?? "", 140)}`);
		}
		if (reasoned.length > REASON_PREVIEW_CAP) step(`  \u21b3 …(+${reasoned.length - REASON_PREVIEW_CAP} more)`);

		const placeholders = collectPlaceholders(maskMessages(entries));
		const additions = mergePatterns(entries, verdict.patterns, placeholders, step);
		if (additions.length === 0) {
			step("The refusal model proposed no usable new patterns; stopping.");
			break;
		}
		entries = [...entries, ...additions];
		await options.onProgress?.(entries);
		step(`Proposed ${plural(additions.length, "pattern")}: ${additions.map(describeEntry).join(", ")}`);

		working(`Re-testing with the main model (round ${iterations + 1})…`);
		const { text: reprobed } = await reprobeMain(entries);
		// At temperature 0, a byte-identical response means the new masks did not
		// touch what the model is reacting to — the trigger is conceptual (the whole
		// request, not a maskable span), so more rounds just pile on futile patterns.
		// Stop instead of grinding to maxIterations.
		if (reprobed === lastReprobe) {
			step("Masking did not change the refusal — the trigger is conceptual, not a maskable span. Stopping.");
			latest = reprobed;
			break;
		}
		lastReprobe = reprobed;
		latest = reprobed;
		step(`Main model re-probed (${latest.length} chars).`);
		step(`Re-probe: ${preview(latest, 200)}`);
	}

	if (!resolved) {
		return {
			resolved: false,
			entries,
			iterations,
			finalResponse: latest,
			reason: entries.length === 0 ? "no patterns proposed" : `still refusing after ${plural(iterations, "round")}`,
		};
	}

	if (entries.length === 0) {
		return { resolved: true, entries, iterations, finalResponse: latest, reason: "no redaction needed" };
	}

	step(`Refusal cleared after ${plural(iterations, "round")} with ${plural(entries.length, "pattern")}.`);

	try {
		// ── Shrink: drop patterns that are not load-bearing ───────────────────────
		if (entries.length > 1) {
			working(`Minimizing ${plural(entries.length, "pattern")}…`);

			// 1) Free pre-pass (no model calls): drop patterns that mask nothing UNIQUE on the re-probe
			// surface (systemPrompt ∪ probeMessages) — their spans are fully covered by others, so the
			// masked text is byte-identical without them and the clearing behavior cannot change.
			const freePass = dropRedundantlyCoveredPatterns(entries, set => JSON.stringify(maskContext(set)));

			// 2) Model-guided removal loop over what remains. The uncensored model PROPOSES which patterns
			// are not load-bearing for this cyber-exploitation refusal (incidental / over-broad terms); a
			// real `trialClears` VERIFIES every proposed batch before it is committed, so soundness never
			// depends on the model's guess. Aggression starts at ~50% of the working set and RESETS on each
			// success (most-aggressive-first: batches ≈ 50%, 25%, 12.5% … of the original) but HALVES on a
			// failed verify (the model over-reached). The budget caps REAL verify trials: each tests a
			// distinct subset (a cache miss ⇒ a re-probe + judge, two full-context model calls); only the
			// final re-verify below is a free memo hit. So keep it fixed and modest.
			const budget = { remaining: MAX_MINIMIZE_TRIALS };
			const mustKeep = await minimizeBySelection(
				freePass.kept,
				(kept, target) => selectRemovals(kept, target),
				trialClears,
				{ budget },
			);

			const keep = new Set(mustKeep);
			const dropped = entries.filter(entry => !keep.has(entry));
			if (dropped.length > 0) {
				// Re-confirm the minimized set still clears before committing — ONE guard covering both the
				// free pre-pass and the model-guided loop (each committed removal was verified per-round, but
				// model nondeterminism could still surface). The committed set is the one tested here, usually
				// a cache hit, so no extra model round-trip. On failure nothing is dropped (the original set,
				// which cleared, stands).
				if (await trialClears(mustKeep)) {
					entries = mustKeep;
					for (const d of dropped) step(`Dropped redundant pattern ${describeEntry(d)}`);
				}
			}
			if (budget.remaining <= 0) step(`Minimization budget reached; kept the remaining patterns.`);
			step(`Minimized to ${plural(entries.length, "pattern")}.`);
		}

		// ── Name: attach innocuous friendly names, verified not to re-trigger ──────
		working("Generating friendly names…");
		const named = await namePatterns(entries, uncensoredModel, completeWithRetry, signal);
		if (named.some((entry, i) => entry.friendlyName !== entries[i]?.friendlyName)) {
			if (await trialClears(named)) {
				entries = named;
				step("Friendly names verified.");
			} else {
				step("Friendly names re-triggered the refusal; keeping unnamed patterns.");
			}
		}
	} catch (err) {
		if (err instanceof FixRefusalAbort) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		step(
			`Skipped minimization/naming after a provider error (${preview(msg, 80)}); keeping the ${plural(entries.length, "pattern")} that cleared the refusal.`,
		);
	}

	return { resolved: true, entries, iterations, finalResponse: latest };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

async function namePatterns(
	entries: SecretEntry[],
	model: Model,
	complete: FixRefusalComplete,
	signal: AbortSignal | undefined,
): Promise<SecretEntry[]> {
	throwIfAborted(signal);
	const instruction = prompt.render(fixRefusalNameTemplate, {
		patterns: entries.map(entry => ({ regex: entry.content, flags: entry.flags ?? "" })),
	});
	const response = await complete({
		model,
		context: {
			systemPrompt: [prompt.render(fixRefusalSystemPrompt)],
			messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }],
			tools: [submitPatternsTool],
		},
		toolChoice: buildNamedToolChoice(SUBMIT_PATTERNS_TOOL, model) ?? "required",
	});
	assertCompleted(response, "refusal model");
	const payload = parseSubmitPatterns(response);

	const nameByRegex = new Map<string, string>();
	for (const pattern of payload.patterns) {
		const name = sanitizeFriendlyName(pattern.friendlyName);
		if (name) nameByRegex.set(pattern.regex, name);
	}
	return entries.map((entry, index) => {
		const name = nameByRegex.get(entry.content) ?? sanitizeFriendlyName(payload.patterns[index]?.friendlyName);
		return name ? { ...entry, friendlyName: name } : entry;
	});
}

/** Compile, validate, drop already-redacted-targeting patterns, and dedupe proposed patterns against existing entries. */
function mergePatterns(
	existing: SecretEntry[],
	proposed: SubmitPatternsPayload["patterns"],
	placeholders: Set<string>,
	step: (line: string) => void,
): SecretEntry[] {
	const seen = new Set(existing.map(entryKey));
	const additions: SecretEntry[] = [];
	for (const pattern of proposed) {
		const entry = toEntry(pattern);
		if (!entry) {
			step(`Skipped invalid regex: /${pattern.regex}/${pattern.flags ?? ""}`);
			continue;
		}
		// Deterministic guard: refuse to re-redact an already-masked span. A pattern
		// that matches an existing $$TOKEN$$ placeholder would corrupt the placeholder
		// (and is never load-bearing — the target can no longer see what it replaced).
		if (matchesPlaceholder(entry, placeholders)) {
			step(`Skipped already-redacted pattern: ${describeEntry(entry)}`);
			continue;
		}
		const key = entryKey(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		additions.push(entry);
	}
	return additions;
}

/** Collect every `$$TOKEN$$` placeholder currently present in the masked transcript. */
function collectPlaceholders(messages: Message[]): Set<string> {
	const found = new Set<string>();
	for (const match of JSON.stringify(messages).matchAll(PLACEHOLDER_RE)) found.add(match[0]);
	return found;
}

/** True when `entry`'s regex matches any already-applied placeholder (i.e. it would re-redact a masked span). */
function matchesPlaceholder(entry: SecretEntry, placeholders: Set<string>): boolean {
	if (placeholders.size === 0) return false;
	let regex: RegExp;
	try {
		regex = compileSecretRegex(entry.content, entry.flags);
	} catch {
		return false;
	}
	for (const placeholder of placeholders) {
		regex.lastIndex = 0; // compileSecretRegex returns a GLOBAL (stateful) regex
		if (regex.test(placeholder)) return true;
	}
	return false;
}

function toEntry(pattern: { regex: string; flags?: string }): SecretEntry | undefined {
	const flags = pattern.flags?.trim() || undefined;
	try {
		compileSecretRegex(pattern.regex, flags);
	} catch {
		return undefined;
	}
	return { type: "regex", content: pattern.regex, mode: "obfuscate", flags };
}

function entryKey(entry: SecretEntry): string {
	return `${entry.content}\u0000${entry.flags ?? ""}`;
}

function describeEntry(entry: SecretEntry): string {
	return `/${entry.content}/${entry.flags ?? ""}`;
}

/**
 * Canonical, order-preserving fingerprint of a pattern set — every field that affects masking
 * (type/content/flags/mode/replacement/friendlyName) and the judge prompt (the content/flags list).
 * Used to memoize trial verdicts. Keying on the SET (not the masked text) is sound: the judge prompt
 * embeds the literal pattern list, so two subsets with identical masked transcripts but different
 * patterns are different judge inputs. A differing friendlyName/flag is therefore a distinct key (so
 * the friendly-name re-verify is never a false hit); the search always presents a subset in its
 * original relative order, so every legitimate re-test still collapses to one key.
 */
export function trialKey(entries: readonly SecretEntry[]): string {
	return JSON.stringify(
		entries.map(e => [e.type, e.content, e.flags ?? "", e.mode ?? "", e.replacement ?? "", e.friendlyName ?? ""]),
	);
}

/** Collapse whitespace and cap to `max` chars for a single-line panel preview. */
function preview(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length === 0) return "(empty)";
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
}

function parseSubmitPatterns(response: AssistantMessage): SubmitPatternsPayload {
	const call = extractToolCall(response, SUBMIT_PATTERNS_TOOL);
	if (call) {
		const parsed = submitPatternsSchema.safeParse(call.arguments);
		if (parsed.success) return parsed.data;
	}
	const text = extractTextContent(response);
	if (text) {
		try {
			const parsed = submitPatternsSchema.safeParse(JSON.parse(text));
			if (parsed.success) return parsed.data;
		} catch {
			// fall through
		}
	}
	return { resolved: false, patterns: [] };
}

function parseSelectRemovable(response: AssistantMessage): number[] {
	const call = extractToolCall(response, SELECT_REMOVABLE_TOOL);
	if (call) {
		const parsed = selectRemovableSchema.safeParse(call.arguments);
		if (parsed.success) return parsed.data.remove;
	}
	const text = extractTextContent(response);
	if (text) {
		try {
			const parsed = selectRemovableSchema.safeParse(JSON.parse(text));
			if (parsed.success) return parsed.data.remove;
		} catch {
			// fall through
		}
	}
	return [];
}

function assertCompleted(response: AssistantMessage, label: string): void {
	if (response.stopReason === "aborted") throw new FixRefusalAbort();
	if (response.stopReason === "error")
		throw new Error(`${label} request failed: ${response.errorMessage ?? "unknown error"}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new FixRefusalAbort();
}

/**
 * Minimize `entries` to a subset that still satisfies the MONOTONE predicate `clears`, by a
 * MODEL-GUIDED backoff loop: `selectRemovals` PROPOSES which entries to drop; a real `clears` trial
 * DECIDES whether each proposed batch is committed. Precondition: `clears(entries)` is true (it is
 * never re-checked here — if nothing is committed the original `entries` is returned unchanged).
 *
 * SOUNDNESS: every commit is preceded by a real `clears(candidate)` returning true, so the returned
 * set always clears. The domain hint the proposer uses (which terms look load-bearing) only improves
 * PROPOSAL quality; correctness never depends on it — a wrong guess just fails a verify and backs off.
 *
 * SCHEDULE (aggression starts 0.5): each round asks for up to `target = round(aggression * |keep|)`
 * removals. A successful verify RESETS aggression to 0.5, so successive successes each shed ~50% of
 * what REMAINS — batch sizes ≈ 50%, 25%, 12.5% … of the original (most-aggressive-first). A failed
 * verify (the proposer over-reached and broke clearing) HALVES aggression, so the next round proposes
 * a smaller, safer batch. This is the only backoff path.
 *
 * NO-OP / STRICT-SHRINK RULE: the proposed removals are validated to membership in `keep` (anything
 * not currently in `keep` is ignored) and `candidate = keep \ removals`. A candidate that does NOT
 * strictly shrink `keep` — i.e. the proposer returned nothing currently removable — STOPS the loop
 * immediately: no verify, no aggression change, no commit. Halving-and-retrying a proposer that
 * returned nothing only burns proposal calls without surfacing removals, so it is not done. Only a
 * strictly smaller candidate is ever verified.
 *
 * TERMINATION (any of): `keep.length <= 1`; `round(aggression * |keep|) < 1` (aggression decayed too
 * far to name even one removal); `budget.remaining <= 0`; or a no-shrink proposal. `budget.remaining`
 * decrements once per dispatched VERIFY trial and so also bounds the round count — total proposal
 * calls stay ≤ verify-rounds + 1 (one possible wasted proposal on the terminal no-shrink round).
 */
export async function minimizeBySelection<T>(
	entries: readonly T[],
	selectRemovals: (keep: readonly T[], target: number) => Promise<readonly T[]>,
	clears: (set: T[]) => Promise<boolean>,
	options: { budget: { remaining: number } },
): Promise<T[]> {
	const { budget } = options;
	let keep = [...entries];
	let aggression = 0.5;
	for (;;) {
		if (keep.length <= 1) break; // nothing left to minimize
		if (budget.remaining <= 0) break; // verify budget (and round count) exhausted
		const target = Math.round(aggression * keep.length);
		if (target < 1) break; // aggression decayed below naming even one removal

		const proposed = await selectRemovals(keep, target);
		// Validate to membership in the CURRENT keep set (a stale / out-of-range pick is ignored), then
		// derive the candidate. removalSet ⊆ keep, so the candidate strictly shrinks keep iff it is
		// non-empty.
		const keepSet = new Set<T>(keep);
		const removalSet = new Set<T>();
		for (const entry of proposed) if (keepSet.has(entry)) removalSet.add(entry);
		if (removalSet.size === 0) break; // no strict shrink → STOP (no verify, no backoff, no commit)
		const candidate = keep.filter(entry => !removalSet.has(entry));

		budget.remaining--; // one dispatched verify trial
		if (await clears(candidate)) {
			keep = candidate; // verified — commit
			aggression = 0.5; // success: stay aggressive (next batch ≈ 50% of what remains)
		} else {
			aggression /= 2; // over-reached and broke clearing: back off to a smaller next batch
		}
	}
	return keep;
}

/**
 * Free pre-pass for {@link minimizeBySelection}: drop every pattern that masks nothing UNIQUE — i.e.
 * removing it leaves `maskKey` byte-identical because its spans are fully covered by other patterns.
 * `maskKey` must serialize the masked re-probe surface (systemPrompt ∪ probeMessages) for a set; the
 * caller supplies it so this stays a pure, model-call-free string comparison. SOUND: identical masked
 * text ⇒ identical re-probe ⇒ identical clearing behavior. Greedy (remove one, recompute the baseline
 * against the shrinking set) so two mutually-covering patterns are not both dropped, and so the rare
 * hash-collision randomness in placeholder bases can only cause a MISSED drop, never a spurious one.
 * Never drops the last remaining pattern — whether it is load-bearing is a question for the verified
 * minimization, not byte-equality.
 */
export function dropRedundantlyCoveredPatterns(
	entries: readonly SecretEntry[],
	maskKey: (set: SecretEntry[]) => string,
): { kept: SecretEntry[]; dropped: SecretEntry[] } {
	const kept = [...entries];
	const dropped: SecretEntry[] = [];
	if (kept.length <= 1) return { kept, dropped };
	let covered = maskKey(kept);
	let i = 0;
	while (i < kept.length && kept.length > 1) {
		const without = kept.filter((_, j) => j !== i);
		if (maskKey(without) === covered) {
			dropped.push(kept[i]!);
			kept.splice(i, 1);
			covered = maskKey(kept);
		} else {
			i++;
		}
	}
	return { kept, dropped };
}

/**
 * A classifier/cyber refusal stores its text in `errorMessage` with
 * `stopReason: "error"` and `stopDetails.type` of "refusal"/"sensitive" — NOT in
 * content blocks, so plain text extraction misses it. Returns that text for such
 * a message, else undefined.
 */
export function classifierRefusalText(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "error") return undefined;
	const type = message.stopDetails?.type;
	if (type !== "refusal" && type !== "sensitive") return undefined;
	return message.errorMessage?.trim() || undefined;
}

// The provider throws a bare `Error(errorMessage)` on a classifier refusal
// (the structured stopDetails is lost in the throw), so the re-probe path must
// recognize a refusal from the message text alone. Anthropic's refusal errors
// start with "Refusal" or the safety-filter phrase.
const REFUSAL_ERROR_PREFIXES: RegExp[] = [/^Refusal\b/i, /^Content flagged by safety filters\b/i];
function isRefusalErrorMessage(message: string): boolean {
	const head = message.trim();
	return REFUSAL_ERROR_PREFIXES.some(pattern => pattern.test(head));
}

/**
 * True when `message` is a refusal — either a structured classifier refusal
 * (stopDetails) or an error-stop whose `errorMessage` is refusal-shaped (the
 * provider often throws away stopDetails, leaving only the text). Used to decide
 * whether to auto-run /fix-refusal.
 */
export function isRefusalMessage(message: AssistantMessage | undefined): boolean {
	if (!message) return false;
	if (classifierRefusalText(message)) return true;
	return message.stopReason === "error" && !!message.errorMessage && isRefusalErrorMessage(message.errorMessage);
}

/** Friendly names are sanitized to letters/digits/spaces and capped for sanity. */
function sanitizeFriendlyName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	const cleaned = name
		.replace(/[^A-Za-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40);
	return cleaned || undefined;
}

/** Serialize converted messages to a labeled transcript for the uncensored analyst. */
function serializeTranscript(messages: Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		const text = collectText(message.content).trim();
		if (text) parts.push(`${ROLE_LABELS[message.role] ?? message.role.toUpperCase()}: ${text}`);
	}
	return parts.join("\n\n");
}

function collectText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(collectBlockText).filter(Boolean).join("\n");
	return "";
}

function collectBlockText(block: unknown): string {
	if (!block || typeof block !== "object") return "";
	const record = block as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.content === "string") return record.content;
	if (Array.isArray(record.content)) return collectText(record.content);
	return "";
}

const ROLE_LABELS: Record<string, string> = {
	user: "USER",
	assistant: "ASSISTANT",
	toolResult: "TOOL",
	developer: "DEVELOPER",
};

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
