/**
 * Contract: session titling never ships a configured secret to the title model, and the
 * title shown to the user carries the real value back.
 *
 * `generateTitle` sends the user's first message to a tiny model through a side channel
 * (`completeSimple`), outside the conversation's provider-context transform, so it must
 * redact the message itself and restore any placeholder the model echoes into the title.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const SECRET = "TITLE-LEAK-SENTINEL-7c21e9";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

describe("AgentSession title generation secret redaction", () => {
	it("redacts a configured secret from the title request and restores it in the returned title", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		expect(placeholder).not.toContain(SECRET);

		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ handler: { content: ["Done"] } }).stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"title.icons": "boring",
				modelRoles: { tiny: `${model.provider}/${model.id}` },
			}),
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator,
		});
		// The title model echoes the placeholder it was shown, as a real model would.
		const completeSimple = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage(`<title>Rotate ${placeholder} deploy token</title>`));

		const title = await session.generateTitle(`Please rotate the deploy token ${SECRET} before Friday`);

		expect(completeSimple).toHaveBeenCalledTimes(1);
		const request = JSON.stringify(completeSimple.mock.calls[0]?.[1]);
		expect(request).not.toContain(SECRET);
		expect(request).toContain(placeholder);
		expect(title).toContain(SECRET);
		expect(title).not.toContain(placeholder);
	});
});
