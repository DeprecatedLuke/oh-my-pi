import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { flattenTopLevelObjectUnion } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as z from "zod/v4";

/**
 * Regression: discriminated-union tools (e.g. `patch`, `issues`) compile to a
 * top-level `oneOf`, but Anthropic rejects the request with
 *   "input_schema does not support oneOf, allOf, or anyOf at the top level".
 * The provider must merge the union into a single object before sending.
 */

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

const patchTool: Tool = {
	name: "patch",
	description: "Manage durable native patches.",
	strict: true,
	parameters: z.discriminatedUnion("op", [
		z.object({
			op: z.literal("list"),
			list_dropped: z.boolean().optional().describe("include patches already marked dropped"),
		}),
		z.object({
			op: z.literal("apply"),
			patch: z.string().describe("patch id to apply"),
			message: z.string().optional(),
		}),
		z.object({
			op: z.literal("reapply"),
			patch: z.string().describe("conflicted patch id to finalize"),
			message: z.string().optional(),
		}),
		z.object({ op: z.literal("drop"), patch: z.string().describe("patch id to mark dropped") }),
	]),
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedTool = { name: string; input_schema: Record<string, unknown> };
type CapturedPayload = { tools?: CapturedTool[] };

function capturePayload(tools: Tool[]): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	const context: Context = {
		systemPrompt: ["Stay concise."],
		messages: [{ role: "user", content: "go", timestamp: Date.now() }],
		tools,
	};
	streamAnthropic(makeAnthropicModel("claude-opus-4-8"), context, {
		apiKey: "sk-ant-test",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as CapturedPayload),
	});
	return promise;
}

describe("Anthropic discriminated-union tool input_schema", () => {
	it("merges a top-level oneOf into a single object schema", async () => {
		const payload = await capturePayload([patchTool]);
		const schema = payload.tools?.find(t => t.name === "patch")?.input_schema;
		expect(schema).toBeDefined();
		if (!schema) return;

		// The 400 trigger: no oneOf/anyOf/allOf may survive at the top level.
		expect(schema.oneOf).toBeUndefined();
		expect(schema.anyOf).toBeUndefined();
		expect(schema.allOf).toBeUndefined();
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);

		// Properties are the union of every branch.
		const properties = schema.properties as Record<string, unknown>;
		expect(Object.keys(properties).sort()).toEqual(["list_dropped", "message", "op", "patch"]);

		// Only the discriminator is required by every branch (required intersection).
		expect(schema.required).toEqual(["op"]);

		// The discriminator literals survive as a nested anyOf of consts, which
		// Anthropic accepts because only the *top* level is restricted.
		const op = properties.op as { anyOf?: Array<{ const?: string }> };
		const opValues = (op.anyOf ?? []).map(variant => variant.const).sort();
		expect(opValues).toEqual(["apply", "drop", "list", "reapply"]);
	});

	it("leaves a plain object tool schema's top level unchanged", async () => {
		const tool: Tool = {
			name: "ping",
			description: "Ping a host.",
			parameters: z.object({ text: z.string(), count: z.number().int().optional() }),
		};
		const schema = (await capturePayload([tool])).tools?.find(t => t.name === "ping")?.input_schema;
		expect(schema?.type).toBe("object");
		expect(schema?.oneOf).toBeUndefined();
		expect(schema?.required).toEqual(["text"]);
		expect((schema?.properties as Record<string, unknown>) ?? {}).toHaveProperty("text");
	});
});

describe("flattenTopLevelObjectUnion", () => {
	it("merges object-only oneOf variants, intersecting required", () => {
		const merged = flattenTopLevelObjectUnion({
			oneOf: [
				{
					type: "object",
					properties: { op: { type: "string", const: "a" }, x: { type: "string" } },
					required: ["op", "x"],
				},
				{
					type: "object",
					properties: { op: { type: "string", const: "b" }, y: { type: "number" } },
					required: ["op"],
				},
			],
		});
		expect(merged.oneOf).toBeUndefined();
		expect(merged.type).toBe("object");
		expect(merged.required).toEqual(["op"]);
		expect(Object.keys(merged.properties as Record<string, unknown>).sort()).toEqual(["op", "x", "y"]);
	});

	it("returns a combinator-free schema unchanged (identity fast path)", () => {
		const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
		expect(flattenTopLevelObjectUnion(schema)).toBe(schema);
	});

	it("strips an unmergeable (non-object) top-level union rather than leaving it", () => {
		const merged = flattenTopLevelObjectUnion({
			anyOf: [{ type: "string" }, { type: "number" }],
		});
		expect(merged.anyOf).toBeUndefined();
		expect(merged.oneOf).toBeUndefined();
	});
});
