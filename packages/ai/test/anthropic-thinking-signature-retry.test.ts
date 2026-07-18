import { describe, expect, it } from "bun:test";
import {
	convertAnthropicMessages,
	isAnthropicInvalidThinkingSignatureError,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression: Anthropic rejects a replayed `thinking` block whose signature it
 * cannot verify (cross-endpoint/key handoff, a proxy whose upstream key differs
 * from the signing key, drifted thinking text) with
 *   messages.N.content.M: Invalid `signature` in `thinking` block
 * The byte-for-byte rule keeps the latest turn's signature, so there is no
 * pre-flight strip. The provider self-heals by retrying with thinking demoted to
 * plain text, which is always accepted. This pins both halves of that fix: the
 * error classifier and the strip-on-retry conversion.
 */

function makeModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-anthropic",
		id: "reasoning-model",
		name: "Reasoning Anthropic-Compatible Model",
		baseUrl: "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text = "continue"): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeSignedAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "custom-anthropic",
		model: "reasoning-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

interface WireBlock {
	type: string;
	[key: string]: unknown;
}

function assistantBlocks(messages: Message[], model: Model<"anthropic-messages">, strip: boolean): WireBlock[] {
	const params = convertAnthropicMessages(messages, model, false, { stripThinkingSignatures: strip });
	const assistant = params.find(p => p.role === "assistant");
	return (assistant?.content as WireBlock[] | undefined) ?? [];
}

describe("isAnthropicInvalidThinkingSignatureError", () => {
	const signatureError = Object.assign(
		new Error("messages.3.content.0: Invalid `signature` in `thinking` block (invalid_request_error)"),
		{ status: 400 },
	);

	it("matches Anthropic's invalid thinking-signature 400", () => {
		expect(isAnthropicInvalidThinkingSignatureError(signatureError)).toBe(true);
	});

	it("ignores a 400 that is not about a signature", () => {
		const oneOfError = Object.assign(
			new Error(
				"tools.13.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level (invalid_request_error)",
			),
			{ status: 400 },
		);
		expect(isAnthropicInvalidThinkingSignatureError(oneOfError)).toBe(false);
	});

	it("ignores a signature error that is not a 400", () => {
		const authError = Object.assign(new Error("Invalid `signature` in `thinking` block (authentication_error)"), {
			status: 401,
		});
		expect(isAnthropicInvalidThinkingSignatureError(authError)).toBe(false);
	});
});

describe("convertAnthropicMessages — stripThinkingSignatures", () => {
	const model = makeModel();

	it("demotes signed thinking to text and emits no thinking block on retry", () => {
		const messages: Message[] = [
			makeUser(),
			makeSignedAssistant([
				{ type: "thinking", thinking: "private chain of thought", thinkingSignature: "sig-abc" },
				{ type: "text", text: "visible answer" },
				{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "x" } },
			]),
		];

		const stripped = assistantBlocks(messages, model, true);
		expect(stripped.some(b => b.type === "thinking")).toBe(false);
		// No empty/foreign signature survives to re-trigger the rejection.
		expect(stripped.every(b => b.type !== "thinking" && !("signature" in b))).toBe(true);
		const text = stripped.filter(b => b.type === "text").map(b => b.text);
		expect(text).toContain("private chain of thought");
		expect(text).toContain("visible answer");
		// The tool call still rides along.
		expect(stripped.some(b => b.type === "tool_use")).toBe(true);
	});

	it("preserves the signed thinking block when not retrying (no regression)", () => {
		const messages: Message[] = [
			makeUser(),
			makeSignedAssistant([
				{ type: "thinking", thinking: "private chain of thought", thinkingSignature: "sig-abc" },
				{ type: "text", text: "visible answer" },
			]),
		];

		const kept = assistantBlocks(messages, model, false);
		const thinking = kept.find(b => b.type === "thinking");
		expect(thinking).toBeDefined();
		expect(thinking?.signature).toBe("sig-abc");
	});

	it("drops redacted_thinking on retry rather than replaying it unsigned", () => {
		const messages: Message[] = [
			makeUser(),
			makeSignedAssistant([
				{ type: "thinking", thinking: "chain", thinkingSignature: "sig-abc" },
				{ type: "redactedThinking", data: "encrypted-blob" },
				{ type: "text", text: "answer" },
			]),
		];

		const stripped = assistantBlocks(messages, model, true);
		expect(stripped.some(b => b.type === "redacted_thinking")).toBe(false);
		expect(stripped.some(b => b.type === "thinking")).toBe(false);
		expect(stripped.filter(b => b.type === "text").map(b => b.text)).toContain("answer");
	});
});
