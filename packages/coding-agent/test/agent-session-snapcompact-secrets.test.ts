/**
 * Contract: the snapcompact compaction path masks secrets before the vision
 * provider ever sees them.
 *
 * snapcompact.compact() films the discarded conversation into provider-bound
 * bitmap frames. The session MUST hand it the secret-masking side-request
 * converter (`#convertToLlmForSideRequest` === obfuscateObject ∘ convertToLlm),
 * NOT the raw module-level `convertToLlm`. With the raw converter, tool outputs
 * and .env reads in the live transcript are rendered into the image archive
 * verbatim and leak to the vision provider. `#obfuscatePreparationForProvider`
 * does NOT compensate — it spreads the live messages through unmasked.
 *
 * This guards the `convertToLlm` option on the `snapcompact.compact` callsite in
 * agent-session.ts (the manual `compact()` path; the auto-compaction path is
 * wired identically). A wrong-but-typed converter still typechecks, so neither
 * tsgo nor the conflict-marker checks can catch this regression — only a test
 * that observes what the callsite actually hands snapcompact can.
 *
 * Deterministic: spy on snapcompact.compact to capture the option the callsite
 * passes (no real provider call, no overflow needed), then prove the captured
 * converter masks a unique sentinel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

// A benign, unique sentinel registered as a plain secret. The obfuscator masks
// any exact plain string, so this need not look like a real key (and avoids
// tripping redactors).
const SECRET_SENTINEL = "SNAPCOMPACT-LEAK-SENTINEL-DO-NOT-SHIP-9b21e7";

describe("AgentSession snapcompact secret obfuscation", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-snapcompact-secrets-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		// Per-test spy teardown: keeps the snapcompact.compact stub from leaking
		// into the rest of the suite.
		vi.restoreAllMocks();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("hands snapcompact.compact a converter that masks secrets before the provider", async () => {
		// Vision-capable model so the `this.model.input.includes("image")` guard
		// makes snapcompact the chosen strategy (text-only models fall back to an
		// LLM summary and never reach snapcompact.compact).
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		expect(model.input).toContain("image");
		// Two seeded turns so prepareCompaction has history to summarize; one spare.
		const mock = createMockModel({
			responses: [{ content: ["ok one"] }, { content: ["ok two"] }, { content: ["spare"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const settings = Settings.isolated({
			// Disable auto-maintenance so prompts never fire snapcompact themselves —
			// the only call must be the manual compact() below (clean call count).
			"compaction.enabled": false,
			// Manual compact() follows the method order; with the vision model above
			// this routes to snapcompact.compact.
			"compaction.methodOrder": ["snapcompact"],
			// keepRecentTokens:1 forces the older turn into messagesToSummarize so the
			// session is never "too small to compact" (compact() would throw first).
			"compaction.keepRecentTokens": 1,
			// Pin the model so pre-prompt context promotion can't swap in a text-only one.
			"contextPromotion.enabled": false,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		// AgentSessionConfig's secret-masking dependency is `obfuscator`; passed by
		// shorthand so the session's `#convertToLlmForSideRequest` masks for real.
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET_SENTINEL }]);

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, obfuscator });

		// Capture the converter the callsite hands snapcompact, and return a
		// minimal-but-valid CompactionResult so compact() completes without a real
		// provider call and without crossing the budget into an LLM-summary fallback.
		let capturedConvertToLlm: ((messages: Message[]) => Message[]) | undefined;
		const compactSpy = vi.spyOn(snapcompact, "compact").mockImplementation(async (preparation, options) => {
			// agent-session binds TMessage=Message at the real callsite; the spy leaves
			// TMessage free (ConvertToLlm<TMessage>), so cast to the concrete converter
			// type — the call below still type-checks its Message[] argument.
			capturedConvertToLlm = options?.convertToLlm as unknown as ((messages: Message[]) => Message[]) | undefined;
			return {
				summary: "snapcompact archived history",
				shortSummary: "snapcompact frames",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { readFiles: [], modifiedFiles: [] },
				preserveData: {},
			};
		});

		// Seed two real turns (the first carrying the sentinel), then drive the
		// public manual-compact path to reach the snapcompact callsite.
		await session.prompt(`first, review this token: ${SECRET_SENTINEL}`);
		await session.prompt("second turn to grow history");
		await session.compact();

		// The callsite reached snapcompact and handed it a converter.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(capturedConvertToLlm).toBeDefined();

		// The contract under test: that converter masks secrets. Feed it a message
		// carrying the sentinel and prove the provider-facing output is masked, not
		// verbatim. With the raw `convertToLlm` (the bug) this output would still
		// contain SECRET_SENTINEL and the next assertion would fail.
		const providerMessages = capturedConvertToLlm!([
			{
				role: "user",
				content: [{ type: "text", text: `inspect credential: ${SECRET_SENTINEL}` }],
				timestamp: Date.now(),
			},
		]);
		const serialized = JSON.stringify(providerMessages);
		expect(serialized).not.toContain(SECRET_SENTINEL);
		expect(serialized).toContain(obfuscator.obfuscate(SECRET_SENTINEL));
	});
});
