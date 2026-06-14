/**
 * Tests for the /fix-refusal orchestrator loop and the managed-secrets
 * load/append helpers. The model is faked content-drivenly so the assertions
 * exercise the real masking + diagnose/shrink/name flow, not a script.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	classifierRefusalText,
	type FixRefusalComplete,
	isRefusalMessage,
	runFixRefusal,
} from "@oh-my-pi/pi-coding-agent/secrets/fix-refusal";
import { appendManagedSecrets, loadSecrets } from "@oh-my-pi/pi-coding-agent/secrets/index";
import {
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

	it("seeds initialEntries and reports growth through onProgress", async () => {
		const snapshots: string[][] = [];
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
			probeMessages: PROBE,
			refusalText: REFUSAL,
			complete,
			initialEntries: [{ type: "regex", content: "Alpha" }],
			onProgress: entries => {
				snapshots.push(entries.map(e => e.content));
			},
		});
		expect(result.resolved).toBe(true);
		// seed flowed in and growth was reported: the first snapshot holds both the seeded and the new pattern.
		expect(snapshots[0]).toEqual(["Alpha", "Beta"]);
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
