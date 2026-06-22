/**
 * Tests for the /fix-refusal orchestrator loop and the managed-secrets
 * load/append helpers. The model is faked content-drivenly so the assertions
 * exercise the real masking + diagnose/shrink/name flow, not a script.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	classifierRefusalText,
	dropRedundantlyCoveredPatterns,
	FixRefusalAbort,
	type FixRefusalComplete,
	isRefusalMessage,
	minimizeClearingSet,
	runFixRefusal,
	trialKey,
} from "@oh-my-pi/pi-coding-agent/secrets/fix-refusal";
import { appendManagedSecrets, loadSecrets } from "@oh-my-pi/pi-coding-agent/secrets/index";
import type { SecretEntry } from "@oh-my-pi/pi-coding-agent/secrets/index";
import {
	createTuiFixRefusalUi,
	type FixRefusalUiClock,
	formatElapsedClock,
	latestUserPromptText,
	probeSliceEnd,
	resolveRefusalModelPattern,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/fix-refusal";

const MAIN = { provider: "anthropic", id: "main", api: "anthropic-messages" } as unknown as Model;
const UNCENSORED = { provider: "anthropic", id: "uncensored", api: "anthropic-messages" } as unknown as Model;
const REFUSAL = "REFUSAL: cannot comply with that request";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {},
		stopReason: "stop",
	} as unknown as AssistantMessage;
}

function textResponse(text: string): AssistantMessage {
	return assistant([{ type: "text", text }]);
}

function errorResponse(msg: string): AssistantMessage {
	return { ...assistant([]), stopReason: "error", errorMessage: msg } as unknown as AssistantMessage;
}

function toolResponse(payload: unknown): AssistantMessage {
	return assistant([
		{ type: "toolCall", id: "1", name: "submit_patterns", arguments: payload as Record<string, unknown> },
	]);
}

function userText(context: Context): string {
	return context.messages
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(block => ("text" in block ? block.text : "")).join(""),
		)
		.join("\n");
}

function section(tag: string, text: string): string {
	return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? "";
}

/**
 * Fake driver: the main model refuses while any term in `refusalCauses` is
 * still visible in its (masked) context; the uncensored model judges the
 * embedded target-response and proposes patterns for `flaggable` terms still
 * visible in the transcript.
 */
function makeDriver(options: { flaggable: string[]; refusalCauses: string[] }): {
	complete: FixRefusalComplete;
	mainCalls: () => number;
} {
	let mainCalls = 0;
	const complete: FixRefusalComplete = async ({ model, context }) => {
		if (model === UNCENSORED) {
			const text = userText(context);
			if (text.includes("friendlyName")) {
				const list = section("patterns", text);
				const patterns = [...list.matchAll(/^- \/(.*)\/(\w*)$/gm)].map(match => ({
					regex: match[1],
					flags: match[2] || undefined,
					friendlyName: "Company",
				}));
				return toolResponse({ resolved: true, patterns });
			}
			if (!section("target-response", text).includes("REFUSAL")) {
				return toolResponse({ resolved: true, patterns: [] });
			}
			const transcript = section("transcript", text);
			const visible = options.flaggable.filter(term => transcript.includes(term));
			return toolResponse({ resolved: false, patterns: visible.map(term => ({ regex: term })) });
		}
		mainCalls++;
		const convo = JSON.stringify(context.messages);
		const refused = options.refusalCauses.some(term => convo.includes(term));
		return textResponse(refused ? REFUSAL : "OK, here is the answer about the company.");
	};
	return { complete, mainCalls: () => mainCalls };
}

const PROBE: Message[] = [
	{ role: "user", content: [{ type: "text", text: "Tell me about SecretCorp and Bob." }], timestamp: 0 },
];

describe("runFixRefusal", () => {
	it("masks the trigger, shrinks to the load-bearing pattern, and names it", async () => {
		const { complete, mainCalls } = makeDriver({ flaggable: ["SecretCorp", "Bob"], refusalCauses: ["SecretCorp"] });
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: ["You are helpful."],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
		});

		expect(result.resolved).toBe(true);
		// Bob never caused the refusal, so the minimizer drops it.
		expect(result.entries.map(entry => entry.content)).toEqual(["SecretCorp"]);
		const [entry] = result.entries;
		expect(entry.type).toBe("regex");
		expect(entry.mode).toBe("obfuscate");
		expect(entry.friendlyName).toBe("Company");
		// The main model was actually re-probed (proves the loop drives it).
		expect(mainCalls()).toBeGreaterThan(0);
	});

	it("reports unresolved when re-probing never clears the refusal", async () => {
		let n = 0;
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				if (userText(context).includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				// Always still refusing; propose a fresh unique pattern each round.
				n += 1;
				return toolResponse({ resolved: false, patterns: [{ regex: `unique${n}` }] });
			}
			return textResponse(REFUSAL);
		};

		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			maxIterations: 2,
		});

		expect(result.resolved).toBe(false);
		expect(result.reason).toMatch(/still refusing/);
		expect(result.entries.length).toBeGreaterThan(0);
	});

	it("returns resolved with no entries when the model did not actually refuse", async () => {
		const complete: FixRefusalComplete = async () => toolResponse({ resolved: true, patterns: [] });
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: "This is a perfectly normal helpful answer.",
			complete,
		});
		expect(result.resolved).toBe(true);
		expect(result.entries).toEqual([]);
	});

	it("minimizes a large redundant pattern set to the single load-bearing pattern", async () => {
		const probe: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Tell me about SecretCorp, Alpha, Beta, Gamma, Delta, and Epsilon." }],
				timestamp: 0,
			},
		];
		const { complete } = makeDriver({
			flaggable: ["SecretCorp", "Alpha", "Beta", "Gamma", "Delta", "Epsilon"],
			refusalCauses: ["SecretCorp"],
		});
		const steps: string[] = [];
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: probe,
			refusalText: REFUSAL,
			complete,
			onStep: line => steps.push(line),
		});
		expect(result.resolved).toBe(true);
		// Only SecretCorp actually drove the refusal; the other five are redundant and dropped.
		expect(result.entries.map(entry => entry.content)).toEqual(["SecretCorp"]);
		for (const term of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]) {
			expect(steps.some(line => line === `Dropped redundant pattern /${term}/`)).toBe(true);
		}
		expect(steps).toContain("Minimized to 1 pattern.");
	});

	it("falls back to greedy removal when redundant patterns interact", async () => {
		const probe: Message[] = [
			{ role: "user", content: [{ type: "text", text: "Tell me about Alpha and Beta." }], timestamp: 0 },
		];
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				const text = userText(context);
				if (text.includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				if (!section("target-response", text).includes("REFUSAL")) {
					return toolResponse({ resolved: true, patterns: [] });
				}
				const transcript = section("transcript", text);
				const visible = ["Alpha", "Beta"].filter(term => transcript.includes(term));
				return toolResponse({ resolved: false, patterns: visible.map(regex => ({ regex })) });
			}
			const convo = JSON.stringify(context.messages);
			const refused = convo.includes("Alpha") && convo.includes("Beta");
			return textResponse(refused ? REFUSAL : "OK, here is the answer.");
		};
		const steps: string[] = [];
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: probe,
			refusalText: REFUSAL,
			complete,
			onStep: line => steps.push(line),
		});
		expect(result.resolved).toBe(true);
		// Masking either term alone suffices, so exactly one load-bearing pattern survives.
		expect(result.entries).toHaveLength(1);
		expect(["Alpha", "Beta"]).toContain(result.entries[0]?.content);
		expect(steps).toContain("Minimized to 1 pattern.");
	});

	it("drops a proposed pattern that targets an already-redacted placeholder", async () => {
		// Round 0: SecretCorp is visible -> judge proposes it -> it gets masked.
		// Round 1+: the main model still refuses (conceptual trigger), and the judge
		// misbehaves by proposing a pattern that matches the #TOKEN# placeholder that
		// now stands in for SecretCorp. The deterministic guard must drop it.
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				const text = userText(context);
				if (text.includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				const transcript = section("transcript", text);
				if (transcript.includes("SecretCorp")) {
					return toolResponse({ resolved: false, patterns: [{ regex: "SecretCorp" }] });
				}
				// SecretCorp is masked now; target the placeholder itself.
				return toolResponse({ resolved: false, patterns: [{ regex: "#[A-Z0-9]{4}" }] });
			}
			return textResponse(REFUSAL); // conceptual refusal: masking never clears it
		};
		const steps: string[] = [];
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			onStep: line => steps.push(line),
		});
		// The bad placeholder-targeting pattern never enters the set; only SecretCorp does.
		expect(result.entries.map(entry => entry.content)).toEqual(["SecretCorp"]);
		expect(steps.some(line => line.startsWith("Skipped already-redacted pattern:"))).toBe(true);
	});

	it("retries a transient provider error then succeeds", async () => {
		let mainCalls = 0;
		let sleeps = 0;
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				const text = userText(context);
				if (text.includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				if (!section("target-response", text).includes("REFUSAL"))
					return toolResponse({ resolved: true, patterns: [] });
				return toolResponse({ resolved: false, patterns: [{ regex: "SecretCorp" }] });
			}
			mainCalls++;
			if (mainCalls <= 2) {
				return {
					...textResponse(""),
					stopReason: "error",
					errorMessage: "Anthropic stream error (rate_limit_error): Rate limited",
				} as unknown as AssistantMessage;
			}
			return textResponse("OK, here is the answer.");
		};
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			sleep: async () => {
				sleeps++;
			},
		});
		expect(result.resolved).toBe(true);
		expect(sleeps).toBe(2); // two transient failures -> two backoff sleeps
		expect(mainCalls).toBe(3);
	});

	it("gives up after maxTransientRetries on a persistent transient error", async () => {
		let sleeps = 0;
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				const text = userText(context);
				if (text.includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				if (!section("target-response", text).includes("REFUSAL"))
					return toolResponse({ resolved: true, patterns: [] });
				return toolResponse({ resolved: false, patterns: [{ regex: "SecretCorp" }] });
			}
			return {
				...textResponse(""),
				stopReason: "error",
				errorMessage: "Anthropic stream error (rate_limit_error): Rate limited",
			} as unknown as AssistantMessage;
		};
		await expect(
			runFixRefusal({
				mainModel: MAIN,
				uncensoredModel: UNCENSORED,
				systemPrompt: [],
				probeMessages: PROBE,
				refusalText: REFUSAL,
				complete,
				maxTransientRetries: 2,
				sleep: async () => {
					sleeps++;
				},
			}),
		).rejects.toThrow(/rate.?limit/i);
		expect(sleeps).toBe(2);
	});

	it("seeds initialEntries, prunes inert resumed patterns, and reports the set through onProgress", async () => {
		const snapshots: string[][] = [];
		const steps: string[] = [];
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				const text = userText(context);
				if (text.includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				if (!section("target-response", text).includes("REFUSAL"))
					return toolResponse({ resolved: true, patterns: [] });
				return toolResponse({ resolved: false, patterns: [{ regex: "Beta" }] });
			}
			return textResponse("OK, here is the answer.");
		};
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE, // "Tell me about SecretCorp and Bob."
			refusalText: REFUSAL,
			complete,
			// "Bob" matches the probe (active); "Stale" is from a prior, different
			// refusal and matches nothing here — it MUST be pruned for free, with no
			// leave-one-out model trial spent on it.
			initialEntries: [
				{ type: "regex", content: "Bob" },
				{ type: "regex", content: "Stale" },
			],
			onProgress: entries => {
				snapshots.push(entries.map(e => e.content));
			},
			onStep: line => steps.push(line),
		});
		expect(result.resolved).toBe(true);
		// The inert resumed pattern was dropped synchronously (zero model calls)...
		expect(steps).toContain("Pruned 1 inert resumed pattern (no match in this conversation).");
		// ...so the first persisted snapshot is the pruned seed (Bob only, no Stale)...
		expect(snapshots[0]).toEqual(["Bob"]);
		// ...and the next growth snapshot adds the freshly proposed pattern.
		expect(snapshots[1]).toEqual(["Bob", "Beta"]);
		// "Stale" never reaches the final set.
		expect(result.entries.every(e => e.content !== "Stale")).toBe(true);
	});
});

/** An error-stop classifier refusal: text lives in errorMessage, content is empty. */
function classifierRefusal(text: string, type: "refusal" | "sensitive" = "refusal"): AssistantMessage {
	return {
		...assistant([]),
		stopReason: "error",
		stopDetails: { type },
		errorMessage: text,
	} as unknown as AssistantMessage;
}

describe("classifierRefusalText", () => {
	it("extracts the errorMessage of an error-stop classifier refusal (refusal/sensitive)", () => {
		expect(classifierRefusalText(classifierRefusal("Refusal (cyber): blocked"))).toBe("Refusal (cyber): blocked");
		expect(classifierRefusalText(classifierRefusal("Content flagged", "sensitive"))).toBe("Content flagged");
	});

	it("returns undefined for a normal answer or a non-classifier error", () => {
		expect(classifierRefusalText(textResponse("a normal helpful answer"))).toBeUndefined();
		const transientError = {
			...assistant([]),
			stopReason: "error",
			stopDetails: { type: "overloaded" },
			errorMessage: "529 overloaded",
		} as unknown as AssistantMessage;
		expect(classifierRefusalText(transientError)).toBeUndefined();
	});
});

describe("runFixRefusal re-probe resilience", () => {
	it("treats a thrown classifier refusal on re-probe as 'still refusing' instead of aborting", async () => {
		// The provider THROWS a bare Error(errorMessage) on a still-refusing
		// classifier re-probe (structured stopDetails lost). The loop must catch it,
		// keep proposing patterns, and finish unresolved — never crash.
		let mainCalls = 0;
		let round = 0;
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				if (userText(context).includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				round += 1;
				return toolResponse({ resolved: false, patterns: [{ regex: `term${round}` }] });
			}
			mainCalls++;
			// Main model keeps hitting the cyber classifier — conceptual trigger,
			// masking never clears it. Provider surfaces this as a thrown error.
			throw new Error("Refusal (cyber): This request triggered restrictions on violative cyber content");
		};

		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: "Refusal (cyber): This request triggered restrictions on violative cyber content",
			complete,
			maxIterations: 2,
		});

		expect(result.resolved).toBe(false);
		expect(result.reason).toMatch(/still refusing/);
		// The loop actually re-probed the main model (didn't abort on the first throw).
		expect(mainCalls).toBeGreaterThan(0);
	});

	it("stops early when masking does not change the refusal (conceptual trigger, no progress)", async () => {
		// Main model returns a BYTE-IDENTICAL refusal every round despite new masks —
		// the trigger is the whole concept, not a maskable span. The loop must detect
		// zero progress and stop, NOT grind to maxIterations piling on futile patterns.
		const CONSTANT_REFUSAL = "Refusal (cyber): This request triggered restrictions on violative cyber content";
		let mainCalls = 0;
		let round = 0;
		const steps: string[] = [];
		const complete: FixRefusalComplete = async ({ model }) => {
			if (model === UNCENSORED) {
				round += 1;
				return toolResponse({ resolved: false, patterns: [{ regex: `freshSpan${round}` }] });
			}
			mainCalls++;
			return textResponse(CONSTANT_REFUSAL);
		};

		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: CONSTANT_REFUSAL,
			complete,
			maxIterations: 6,
			onStep: line => steps.push(line),
		});

		expect(result.resolved).toBe(false);
		// Stopped at the 2nd identical reprobe, NOT after all 6 rounds.
		expect(mainCalls).toBe(2);
		expect(steps.some(line => /conceptual/i.test(line))).toBe(true);
	});

	it("rethrows a non-refusal error from the main model (does not swallow real failures)", async () => {
		const complete: FixRefusalComplete = async ({ model }) => {
			if (model === UNCENSORED) return toolResponse({ resolved: false, patterns: [{ regex: "x" }] });
			throw new Error("400 invalid request: malformed tool schema");
		};
		await expect(
			runFixRefusal({
				mainModel: MAIN,
				uncensoredModel: UNCENSORED,
				systemPrompt: [],
				probeMessages: PROBE,
				refusalText: REFUSAL,
				complete,
				maxIterations: 2,
			}),
		).rejects.toThrow(/400 invalid request/);
	});
});

describe("runFixRefusal cancellation", () => {
	it("aborts the run when the signal fires mid-loop, throwing FixRefusalAbort", async () => {
		const controller = new AbortController();
		let uncensoredCalls = 0;
		// The judge proposes a pattern (never resolving), and we abort the signal
		// right after the first verdict — so the NEXT throwIfAborted (in the
		// re-probe) must surface FixRefusalAbort instead of grinding on.
		const complete: FixRefusalComplete = async ({ model }) => {
			if (model === UNCENSORED) {
				uncensoredCalls += 1;
				controller.abort();
				return toolResponse({ resolved: false, patterns: [{ regex: "SecretCorp" }] });
			}
			return textResponse(REFUSAL);
		};

		await expect(
			runFixRefusal({
				mainModel: MAIN,
				uncensoredModel: UNCENSORED,
				systemPrompt: [],
				probeMessages: PROBE,
				refusalText: REFUSAL,
				complete,
				signal: controller.signal,
				maxIterations: 6,
			}),
		).rejects.toBeInstanceOf(FixRefusalAbort);
		// It got exactly one judge verdict in before the abort halted the loop —
		// proof the abort short-circuits rather than running to maxIterations.
		expect(uncensoredCalls).toBe(1);
	});

	it("throws FixRefusalAbort immediately when the signal is already aborted", async () => {
		let calls = 0;
		const complete: FixRefusalComplete = async () => {
			calls += 1;
			return textResponse(REFUSAL);
		};
		await expect(
			runFixRefusal({
				mainModel: MAIN,
				uncensoredModel: UNCENSORED,
				systemPrompt: [],
				probeMessages: PROBE,
				refusalText: REFUSAL,
				complete,
				signal: AbortSignal.abort(),
			}),
		).rejects.toBeInstanceOf(FixRefusalAbort);
		// No model call happened — the pre-flight throwIfAborted fired first.
		expect(calls).toBe(0);
	});
});

describe("runFixRefusal progress reporting", () => {
	it("reports the authoritative judge verdict per round, not a cosmetic refusal guess", async () => {
		// Stays unresolved for the capped rounds, proposing a fresh pattern each
		// time, so we observe both the iteration-0 and the later-round verdict lines.
		let n = 0;
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				if (userText(context).includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				n += 1;
				return toolResponse({ resolved: false, patterns: [{ regex: `unique${n}` }] });
			}
			return textResponse(REFUSAL);
		};
		const steps: string[] = [];

		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			maxIterations: 3,
			onStep: line => steps.push(line),
		});

		expect(result.resolved).toBe(false);
		// First round states the judge confirmed a refusal...
		expect(steps).toContain("Refusal model confirmed a refusal; proposing masks.");
		// ...later rounds attribute the continuation to the judge still flagging it.
		expect(steps.some(line => line.startsWith("Refusal model still flags the response"))).toBe(true);
		// The re-probe line is now a factual size report.
		expect(steps.some(line => /^Main model re-probed \(\d+ chars\)\.$/.test(line))).toBe(true);
		// The old cosmetic heuristic annotation is gone — it contradicted the judge.
		expect(steps.some(line => line.includes("— still refusing"))).toBe(false);
		expect(steps.some(line => line.startsWith("Main model responded"))).toBe(false);
	});
});

describe("runFixRefusal visibility + resilience", () => {
	it("surfaces the refusal text and re-probe responses inline", async () => {
		const { complete } = makeDriver({ flaggable: ["SecretCorp"], refusalCauses: ["SecretCorp"] });
		const steps: string[] = [];
		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: ["You are helpful."],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			onStep: line => steps.push(line),
		});

		expect(result.resolved).toBe(true);
		// The refusal text is echoed inline, including a recognizable fragment.
		const refusalLine = steps.find(line => line.startsWith("Refusal: "));
		expect(refusalLine).toBeDefined();
		expect(refusalLine).toContain("cannot comply");
		// The main model's re-probe response is echoed inline.
		expect(steps.some(line => line.startsWith("Re-probe: "))).toBe(true);
		// The pinned factual size line is unchanged...
		expect(steps.some(line => /^Main model re-probed \(\d+ chars\)\.$/.test(line))).toBe(true);
		// ...and the old "Main model responded" prefix is never emitted.
		expect(steps.some(line => line.startsWith("Main model responded"))).toBe(false);
	});

	it("surfaces the judge's per-pattern reasoning when provided", async () => {
		const steps: string[] = [];
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				const text = userText(context);
				if (text.includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				if (!section("target-response", text).includes("REFUSAL")) {
					return toolResponse({ resolved: true, patterns: [] });
				}
				return toolResponse({
					resolved: false,
					patterns: [{ regex: "SecretCorp", reason: "company name triggers the filter" }],
				});
			}
			return textResponse(
				JSON.stringify(context.messages).includes("SecretCorp")
					? REFUSAL
					: "OK, here is the answer about the company.",
			);
		};

		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			onStep: line => steps.push(line),
		});

		expect(result.resolved).toBe(true);
		const reasonLine = steps.find(line => line.includes("company name triggers the filter"));
		expect(reasonLine).toBeDefined();
		expect(reasonLine?.startsWith("  \u21b3 ")).toBe(true);
	});

	it("keeps the cleared patterns when a minimization step fails", async () => {
		const probe: Message[] = [
			{ role: "user", content: [{ type: "text", text: "Tell me about Alpha and Beta." }], timestamp: 0 },
		];
		const steps: string[] = [];
		let clearedOnce = false;
		const complete: FixRefusalComplete = async ({ model, context }) => {
			if (model === UNCENSORED) {
				const text = userText(context);
				if (text.includes("friendlyName")) return toolResponse({ resolved: true, patterns: [] });
				if (!section("target-response", text).includes("REFUSAL")) {
					return toolResponse({ resolved: true, patterns: [] });
				}
				const transcript = section("transcript", text);
				const visible = ["Alpha", "Beta"].filter(term => transcript.includes(term));
				return toolResponse({ resolved: false, patterns: visible.map(term => ({ regex: term })) });
			}
			const convo = JSON.stringify(context.messages);
			const wouldRefuse = ["Alpha", "Beta"].some(term => convo.includes(term));
			if (!wouldRefuse) {
				clearedOnce = true;
				return textResponse("OK, here is the answer about the companies.");
			}
			// A leave-one-out shrink trial after the full set already cleared: the
			// provider blows up with a hard (non-refusal, non-transient) error.
			if (clearedOnce) throw new Error("provider exploded: kaboom");
			return textResponse(REFUSAL);
		};

		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: probe,
			refusalText: REFUSAL,
			complete,
			sleep: async () => {},
			onStep: line => steps.push(line),
		});

		expect(result.resolved).toBe(true);
		// The full cleared set is kept — minimization threw before dropping anything.
		expect(result.entries.map(entry => entry.content).sort()).toEqual(["Alpha", "Beta"]);
		expect(steps.some(line => line.startsWith("Skipped minimization/naming"))).toBe(true);
	});

	it("retries a transient stream-stall error instead of failing", async () => {
		const base = makeDriver({ flaggable: ["SecretCorp"], refusalCauses: ["SecretCorp"] });
		const steps: string[] = [];
		let unc = 0;
		const complete: FixRefusalComplete = async request => {
			if (request.model === UNCENSORED) {
				unc += 1;
				if (unc === 1) return errorResponse("Anthropic stream stalled while waiting for the next event");
			}
			return base.complete(request);
		};

		const result = await runFixRefusal({
			mainModel: MAIN,
			uncensoredModel: UNCENSORED,
			systemPrompt: [],
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			sleep: async () => {},
			onStep: line => steps.push(line),
		});

		expect(result.resolved).toBe(true);
		// The stalled call was retried (>= 2 uncensored calls), not surfaced as a failure.
		expect(unc).toBeGreaterThanOrEqual(2);
		expect(steps.some(line => line.startsWith("Transient provider error"))).toBe(true);
	});
});

describe("managed secrets load/append", () => {
	it("appends, dedupes, and merges with hand-authored secrets", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-agent-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-cwd-"));
		try {
			await Bun.write(path.join(agentDir, "secrets.yml"), '- { type: plain, content: "HANDWRITTEN" }\n');

			const first = await appendManagedSecrets(agentDir, [
				{ type: "regex", content: "SecretCorp", mode: "obfuscate", friendlyName: "Company" },
			]);
			expect(first.added).toBe(1);

			// Re-appending the same pattern is a no-op.
			const second = await appendManagedSecrets(agentDir, [
				{ type: "regex", content: "SecretCorp", mode: "obfuscate" },
			]);
			expect(second.added).toBe(0);
			expect(second.total).toBe(1);

			// A new pattern is appended alongside the existing one.
			const third = await appendManagedSecrets(agentDir, [{ type: "regex", content: "OtherTerm" }]);
			expect(third.added).toBe(1);
			expect(third.total).toBe(2);

			const merged = await loadSecrets(cwd, agentDir);
			const contents = merged.map(entry => entry.content).sort();
			expect(contents).toEqual(["HANDWRITTEN", "OtherTerm", "SecretCorp"]);
			const managed = merged.find(entry => entry.content === "SecretCorp");
			expect(managed?.friendlyName).toBe("Company");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("resolveRefusalModelPattern", () => {
	it("returns the configured uncensored model role", () => {
		const settings = Settings.isolated({});
		settings.setModelRole("uncensored", "anthropic/uncensored-model");
		expect(resolveRefusalModelPattern(settings)).toBe("anthropic/uncensored-model");
	});

	it("returns undefined when the uncensored role is not configured", () => {
		const settings = Settings.isolated({});
		expect(resolveRefusalModelPattern(settings)).toBeUndefined();
	});
});

describe("probeSliceEnd", () => {
	const roles = (...rs: string[]) => rs.map(role => ({ role }));

	it("includes post-user tool activity, cutting only the trailing refusal turn", () => {
		// user → assistant(tool call) → toolResult → assistant(refusal).
		// The trigger lives in the toolResult, so the slice MUST keep it (end=3),
		// excluding only the refusal at index 3.
		expect(probeSliceEnd(roles("user", "assistant", "toolResult", "assistant"))).toBe(3);
	});

	it("keeps several tool round-trips, cutting only the final refusal", () => {
		// user → a → tr → a → tr → a(refusal): end=5 keeps both tool round-trips.
		expect(probeSliceEnd(roles("user", "assistant", "toolResult", "assistant", "toolResult", "assistant"))).toBe(5);
	});

	it("handles a direct refusal with no tool activity (user → refusal)", () => {
		expect(probeSliceEnd(roles("user", "assistant"))).toBe(1);
	});

	it("falls back to just after the user turn when no assistant turn follows", () => {
		expect(probeSliceEnd(roles("user"))).toBe(1);
	});

	it("returns null when there is no user turn to re-test", () => {
		expect(probeSliceEnd(roles("assistant", "toolResult"))).toBeNull();
		expect(probeSliceEnd(roles())).toBeNull();
	});

	it("anchors on the LAST user turn (ignores earlier turns)", () => {
		// earlier user/assistant pair, then the real turn: user@2 → a → tr → a(refusal@5).
		expect(probeSliceEnd(roles("user", "assistant", "user", "assistant", "toolResult", "assistant"))).toBe(5);
	});
});

describe("isRefusalMessage", () => {
	it("detects a structured classifier refusal and a refusal-shaped error stop", () => {
		expect(isRefusalMessage(classifierRefusal("Refusal (cyber): blocked"))).toBe(true);
		const errorStop = {
			...textResponse(""),
			stopReason: "error",
			errorMessage: "Content flagged by safety filters",
		} as unknown as AssistantMessage;
		expect(isRefusalMessage(errorStop)).toBe(true);
	});
	it("returns false for a normal answer, a non-refusal error, and undefined", () => {
		expect(isRefusalMessage(textResponse("a normal helpful answer"))).toBe(false);
		const overloaded = {
			...textResponse(""),
			stopReason: "error",
			errorMessage: "529 overloaded",
		} as unknown as AssistantMessage;
		expect(isRefusalMessage(overloaded)).toBe(false);
		expect(isRefusalMessage(undefined)).toBe(false);
	});
});

describe("latestUserPromptText", () => {
	it("returns the most recent user turn's text", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 },
		] as unknown as Parameters<typeof latestUserPromptText>[0];
		expect(latestUserPromptText(messages)).toBe("second");
	});
	it("returns undefined when there is no user turn", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 0 },
		] as unknown as Parameters<typeof latestUserPromptText>[0];
		expect(latestUserPromptText(messages)).toBeUndefined();
	});
});

describe("/fix-refusal spinner elapsed clock", () => {
	// The TUI wrapper's render() colors lines via the global `theme`, which is
	// undefined until initTheme() runs; initialize it once for this block.
	beforeAll(async () => {
		await initTheme(false);
	});

	it("formatElapsedClock: blank under 1s, bare seconds, then minutes past 60s", () => {
		// No `· 0s` noise: anything under a full second renders nothing.
		expect(formatElapsedClock(0)).toBe("");
		expect(formatElapsedClock(999)).toBe("");
		// Whole seconds, no minute prefix below 60s.
		expect(formatElapsedClock(1000)).toBe("1s");
		expect(formatElapsedClock(14000)).toBe("14s");
		expect(formatElapsedClock(59000)).toBe("59s");
		// Past a minute: `Nm SSs` with zero-padded seconds.
		expect(formatElapsedClock(60000)).toBe("1m 00s");
		expect(formatElapsedClock(83000)).toBe("1m 23s");
	});

	// Fresh wrapper over a fake ctx (records every setWorkingMessage) and a fake
	// clock (deterministic now() + a manually-invokable interval handler), so the
	// 1s ticking is exercised without real timers.
	function makeHarness() {
		const msgs: (string | undefined)[] = [];
		const state = { nowMs: 0, handler: undefined as (() => void) | undefined, cleared: 0, stopCalls: 0 };
		const ctx = {
			setWorkingMessage: (m?: string) => {
				msgs.push(m);
			},
			ensureLoadingAnimation: () => {},
			stopLoadingAnimation: () => {
				state.stopCalls++;
			},
			present: () => {},
			ui: { requestRender: () => {} },
		} as unknown as Parameters<typeof createTuiFixRefusalUi>[0];
		const clock: FixRefusalUiClock = {
			now: () => state.nowMs,
			setInterval: h => {
				state.handler = h;
				return {} as NodeJS.Timeout;
			},
			clearInterval: () => {
				state.cleared++;
				state.handler = undefined;
			},
		};
		const ui = createTuiFixRefusalUi(ctx, clock);
		return { ui, msgs, state };
	}

	const ROUND1_ANALYZE = `Analyzing the refusal (round 1)\u2026`;
	const ROUND1_REPROBE = `Re-testing with the main model (round 1)\u2026`;

	it("paints the bare base, ticks an elapsed suffix, and restarts the clock per phase", () => {
		const { ui, msgs, state } = makeHarness();
		ui.working(ROUND1_ANALYZE);
		// Bare base on the first paint (0s elapsed → no suffix), and a clock is scheduled.
		expect(msgs.at(-1)).toBe(ROUND1_ANALYZE);
		expect(state.handler).toBeDefined();
		// A tick at 14s appends the suffix with exactly one `· ` separator (no double space).
		state.nowMs = 14000;
		state.handler?.();
		expect(msgs.at(-1)).toBe(`${ROUND1_ANALYZE} \u00b7 14s`);
		// A new working() phase tears down the prior interval and resets the base...
		state.nowMs = 15000;
		ui.working(ROUND1_REPROBE);
		expect(state.cleared).toBe(1);
		expect(msgs.at(-1)).toBe(ROUND1_REPROBE);
		// ...restarting elapsed from 15000, so 16000 reads as 1s, never the stale 16s.
		state.nowMs = 16000;
		state.handler?.();
		expect(msgs.at(-1)).toBe(`${ROUND1_REPROBE} \u00b7 1s`);
	});

	it("step() tears down the live clock and clears the working message (pitfall c)", () => {
		const { ui, msgs, state } = makeHarness();
		ui.working(ROUND1_ANALYZE);
		ui.step("Main model re-probed (5 chars).");
		// step() clears the interval AND the working message, so a stale "· Ns" cannot
		// repaint between phases; the next working() restarts it.
		expect(state.cleared).toBe(1);
		expect(state.handler).toBeUndefined();
		expect(msgs.at(-1)).toBeUndefined();
	});

	it("done() tears down the live clock and stops the loading animation (pitfall b)", () => {
		const { ui, msgs, state } = makeHarness();
		ui.working(ROUND1_ANALYZE);
		ui.done();
		// done() clears the interval (so it cannot resurface a stale clock on the next
		// turn's spinner) and stops the loading animation exactly once.
		expect(state.cleared).toBe(1);
		expect(state.stopCalls).toBe(1);
		expect(state.handler).toBeUndefined();
		expect(msgs.at(-1)).toBeUndefined();
	});
});

describe("minimizeClearingSet (parallel breadth-first ddmin)", () => {
	const counted = (clears: (s: string[]) => boolean) => {
		let calls = 0;
		const fn = async (s: string[]) => {
			calls++;
			return clears(s);
		};
		return { fn, calls: () => calls };
	};
	const opts = (remaining = 256, concurrency = 6) => ({ concurrency, budget: { remaining } });

	it("drops the entire redundant block when every element is independent", async () => {
		const { fn } = counted(() => true);
		const result = await minimizeClearingSet<string>(["a", "b", "c", "d"], fn, opts());
		expect(result).toEqual([]); // union of all droppable chunks removed at once
	});

	it("isolates a single scattered essential", async () => {
		const { fn, calls } = counted(s => s.includes("d"));
		const result = await minimizeClearingSet<string>(["a", "b", "c", "d", "e", "f", "g", "h"], fn, opts());
		expect(result).toEqual(["d"]);
		expect(calls()).toBeLessThan(16);
	});

	it("isolates a single essential in a large clustered set with sub-linear trials", async () => {
		const candidates = Array.from({ length: 32 }, (_, i) => `c${i}`);
		const { fn, calls } = counted(s => s.includes("c0"));
		const result = await minimizeClearingSet<string>(candidates, fn, opts());
		expect(result).toEqual(["c0"]);
		expect(calls()).toBeLessThan(32);
	});

	it("keeps both essentials when two redundant patterns interact (union-drop unsafe → greedy)", async () => {
		const { fn } = counted(s => s.includes("b") && s.includes("f"));
		const result = await minimizeClearingSet<string>(["a", "b", "c", "d", "e", "f", "g", "h"], fn, opts());
		expect([...result].sort()).toEqual(["b", "f"]);
	});

	it("keeps every member when all are essential (1-minimal)", async () => {
		const { fn } = counted(s => s.length === 3);
		const result = await minimizeClearingSet<string>(["a", "b", "c"], fn, opts());
		expect([...result].sort()).toEqual(["a", "b", "c"]);
	});

	it("soundness: the returned subset always clears", async () => {
		const clears = (s: string[]) => s.includes("b") && s.includes("f");
		const { fn } = counted(clears);
		const result = await minimizeClearingSet<string>(["a", "b", "c", "d", "e", "f", "g", "h"], fn, opts());
		expect(clears(result)).toBe(true);
	});

	it("respects the trial budget and keeps the still-clearing working set on exhaustion", async () => {
		// All 8 essential: no chunk removal ever clears, so nothing is committed. A budget of 3 caps the
		// probes; the precondition guarantees the kept (full) set still clears.
		const candidates = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const clears = (s: string[]) => s.length === 8;
		const { fn, calls } = counted(clears);
		const result = await minimizeClearingSet<string>(candidates, fn, opts(3));
		expect(calls()).toBeLessThanOrEqual(3);
		expect(result).toHaveLength(8);
		expect(clears(result)).toBe(true);
	});

	it("budget charges exactly one per dispatched probe (no double-count, hits never reached in-search)", async () => {
		const candidates = Array.from({ length: 16 }, (_, i) => `c${i}`);
		const { fn, calls } = counted(s => s.includes("c0"));
		const budget = { remaining: 256 };
		await minimizeClearingSet<string>(candidates, fn, { concurrency: 4, budget });
		// Every dispatched subset in one run is distinct, so dispatches == real calls == budget spent.
		expect(256 - budget.remaining).toBe(calls());
	});

	it("runs probes concurrently, bounded by `concurrency`", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const concurrency = 3;
		const clearsFn = async (s: string[]) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Bun.sleep(2);
			inFlight--;
			return s.includes("z");
		};
		// 8 candidates → first round splits in 2, later rounds widen to 4/8 chunks → several parallel probes.
		const result = await minimizeClearingSet<string>(["z", "a", "b", "c", "d", "e", "f", "g"], clearsFn, {
			concurrency,
			budget: { remaining: 256 },
		});
		expect(result).toEqual(["z"]);
		expect(maxInFlight).toBeGreaterThan(1); // genuinely parallel
		expect(maxInFlight).toBeLessThanOrEqual(concurrency); // bounded
	});

	// ── Regression: the user's 162→162 "zero reduction" bug ────────────────────────────────────────
	// A few SCATTERED essentials among many candidates, with a budget far below N. The breadth-first
	// coarse→fine ordering (biggest redundant blocks dropped FIRST) MUST still shed a large fraction on
	// a partial budget — the old depth-first bisection returned the whole input here. The assertion is
	// deliberately `length <= N/2` (≥ half DROPPED): that FAILS under the zero-reduction behavior, where
	// a `dropped <= N/2` bound would pass trivially and guard nothing.
	it("regression: tight budget still drops ≥ half of a large scattered set, generous budget is exact", async () => {
		const N = 120;
		const essentials = new Set(["c5", "c60", "c110"]);
		const candidates = Array.from({ length: N }, (_, i) => `c${i}`);
		const clears = (s: string[]) => [...essentials].every(e => s.includes(e));

		// Tight budget: a small multiple of log2(N), far below N.
		const tight = counted(clears);
		const tightResult = await minimizeClearingSet<string>(candidates, tight.fn, opts(20, 6));
		expect(clears(tightResult)).toBe(true); // (i) still clears
		expect(tightResult.length).toBeLessThanOrEqual(N / 2); // (ii) ≥ half dropped — fails on zero-reduction
		const droppedAtTightBudget = N - tightResult.length;
		expect(droppedAtTightBudget).toBeGreaterThanOrEqual(N / 2);

		// Generous budget: reaches the exact essential set (1-minimal).
		const generous = counted(clears);
		const exact = await minimizeClearingSet<string>(candidates, generous.fn, opts(2048, 6));
		expect([...exact].sort()).toEqual(["c110", "c5", "c60"]);
	});
});

describe("dropRedundantlyCoveredPatterns (free pre-pass)", () => {
	const entry = (content: string): SecretEntry => ({ type: "regex", content });
	// Simulate masking: each pattern blanks out occurrences of its `content` in a fixed probe text.
	// A pattern whose spans are already covered by others leaves the masked text byte-identical.
	const maskKeyOver = (probe: string) => (set: SecretEntry[]): string => {
		let masked = probe;
		for (const e of set) masked = masked.split(e.content).join("\u2588".repeat(e.content.length));
		return masked;
	};

	it("drops a fully-covered duplicate with no clears predicate involved (zero model calls)", () => {
		// "Bar" is a substring of "FooBar": masking "FooBar" already blanks the "Bar" span, so "Bar" is
		// redundant. The function takes no `clears` argument at all — it cannot make a model call.
		const entries = [entry("FooBar"), entry("Bar")];
		const { kept, dropped } = dropRedundantlyCoveredPatterns(entries, maskKeyOver("Talk about FooBar please."));
		expect(kept.map(e => e.content)).toEqual(["FooBar"]);
		expect(dropped.map(e => e.content)).toEqual(["Bar"]);
	});

	it("greedily keeps one of two mutually-covering duplicates, never both", () => {
		const entries = [entry("SecretCorp"), entry("SecretCorp")];
		const { kept, dropped } = dropRedundantlyCoveredPatterns(entries, maskKeyOver("About SecretCorp."));
		expect(kept).toHaveLength(1);
		expect(dropped).toHaveLength(1);
	});

	it("keeps patterns that each mask something unique", () => {
		const entries = [entry("Alpha"), entry("Beta")];
		const { kept, dropped } = dropRedundantlyCoveredPatterns(entries, maskKeyOver("Alpha and Beta."));
		expect(kept).toHaveLength(2);
		expect(dropped).toHaveLength(0);
	});

	it("never drops the last remaining pattern", () => {
		const entries = [entry("Solo")];
		const { kept, dropped } = dropRedundantlyCoveredPatterns(entries, maskKeyOver("no match here"));
		expect(kept).toHaveLength(1);
		expect(dropped).toHaveLength(0);
	});
});

describe("trialKey (memoization key)", () => {
	const e = (over: Partial<SecretEntry>): SecretEntry => ({ type: "regex", content: "X", ...over });

	it("is stable for identical sets in the same order", () => {
		expect(trialKey([e({ content: "a" }), e({ content: "b" })])).toBe(trialKey([e({ content: "a" }), e({ content: "b" })]));
	});

	it("distinguishes a differing friendlyName so the friendly-name re-verify is never a false hit", () => {
		expect(trialKey([e({ content: "a" })])).not.toBe(trialKey([e({ content: "a", friendlyName: "Company" })]));
	});

	it("distinguishes differing flags", () => {
		expect(trialKey([e({ content: "a", flags: "i" })])).not.toBe(trialKey([e({ content: "a" })]));
	});
});
