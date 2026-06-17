/**
 * Contract: the advisor's provider request never receives raw secrets.
 *
 * The advisor is fed the primary transcript delta (rendered from RAW `state.messages` —
 * user turns and tool outputs are NOT stored obfuscated) and runs its own read-only
 * tools, so its Agent MUST apply the session's secret obfuscation before any provider
 * call, exactly like every other side request (`#convertToLlmForSideRequest`). This
 * guards the wiring at agent-session.ts (`convertToLlm` on the advisor Agent): without
 * it the advisor's model sees secrets verbatim.
 *
 * Recording works because the advisor Agent inherits the session's `streamFn`
 * (`this.agent.streamFn` -> the mock here), and MockModel records each call's post-
 * convertToLlm `context`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

// A benign, unique sentinel registered as a plain secret. The obfuscator masks any exact
// plain string, so this need not look like a real key (and avoids tripping redactors).
const SECRET_SENTINEL = "ADVISOR-LEAK-SENTINEL-DO-NOT-SHIP-4f3a9c";

describe("AgentSession advisor secret obfuscation", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-advisor-secrets-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("masks primary-transcript secrets in the advisor's provider request", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		// One response for the primary turn, one for the advisor's catch-up turn (+ spare).
		const mock = createMockModel({
			responses: [{ content: ["primary ok"] }, { content: ["advisor ok"] }, { content: ["extra"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			// Force the turn to await the advisor catch-up so the advisor's model call is
			// recorded before `prompt()` resolves (threshold 1 => wait until fully drained).
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET_SENTINEL }]);

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, obfuscator });
		// Enable BEFORE the secret-bearing turn so the prompt lands in the advisor's first delta.
		expect(session.setAdvisorEnabled(true)).toBe(true);

		await session.prompt(`Please review this credential: ${SECRET_SENTINEL}`);

		// The advisor's call is the one carrying the rendered transcript delta.
		const advisorCall = mock.calls.find(call => JSON.stringify(call.context.messages).includes("### Session update"));
		expect(advisorCall).toBeDefined();
		const serialized = JSON.stringify(advisorCall?.context.messages);
		// The delta (which carried the secret) reached the advisor...
		expect(serialized).toContain("### Session update");
		// ...but the secret itself was obfuscated to its placeholder before the provider saw it.
		expect(serialized).not.toContain(SECRET_SENTINEL);
		expect(serialized).toContain(obfuscator.obfuscate(SECRET_SENTINEL));
	});
});
