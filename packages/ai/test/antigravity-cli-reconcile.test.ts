import { describe, expect, it } from "bun:test";
import {
	AGY_PROMPT_BYTES,
	type Ledger,
	inputBlocks,
	lateToolResultPrompt,
	planTurn,
	replayPrompt,
	toolResultImagesPrompt,
	transcriptDigest,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/reconcile";
import type {
	AntigravityCliPayload,
	AssistantMessage,
	Message,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistant(text: string, toolCallIds: string[] = [], payload?: AntigravityCliPayload): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCallIds.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a.txt" } })),
		],
		api: "antigravity-acp",
		provider: "antigravity-cli",
		model: "gemini-3.8-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallIds.length > 0 ? "toolUse" : "stop",
		providerPayload: payload,
		timestamp: 0,
	};
}

/** An assistant step from another provider; agy never saw it, so its content is part of the digest. */
function foreignAssistant(text: string, toolCallIds: string[] = []): AssistantMessage {
	return { ...assistant(text, toolCallIds), provider: "anthropic", api: "anthropic-messages" };
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

/** A transcript whose last message is a turn end agy recorded, as the transport stamps it. */
function recordedTurn(messages: Message[], conversationId: string): Message[] {
	const end = assistant("done");
	const withEnd = [...messages, end];
	end.providerPayload = {
		type: "antigravityCli",
		conversationId,
		digest: transcriptDigest(withEnd),
		checkpoint: { steps: 2, generations: 1, executions: 1 },
	};
	return withEnd;
}

function ledgerFor(messages: Message[], pendingToolCallId?: string): Ledger {
	return { count: messages.length, digest: transcriptDigest(messages), pendingToolCallId };
}

describe("planTurn", () => {
	it("returns the held tool call's result to agy and steers with input sent after it", () => {
		const seen = [user("read a.txt"), assistant("reading", ["call-1"])];
		const result = toolResult("call-1", "file body");
		const steer = user("also check b.txt");

		const plan = planTurn([...seen, result, steer], ledgerFor(seen, "call-1"));

		expect(plan).toEqual({ kind: "resume", toolResult: result, input: [steer] });
	});

	it("resumes when omp rewrote earlier tool results, tool arguments or agy's own text and thinking", () => {
		const reading = assistant("reading", ["call-1"]);
		reading.content.unshift({ type: "thinking", thinking: "look at a.txt" });
		const seen = [user("read a.txt"), reading, toolResult("call-1", "token=hunter2"), assistant("summary")];
		const pruned = assistant("", ["call-1"]);
		const call = pruned.content[1];
		if (call?.type !== "toolCall") throw new Error("Missing test tool call");
		call.arguments = { path: "[REDACTED]" };
		const rewritten = [
			user("read a.txt"),
			pruned,
			{ ...toolResult("call-1", "token=[REDACTED]"), isError: true },
			assistant(""),
		];

		const plan = planTurn([...rewritten, user("next")], ledgerFor(seen));

		expect(plan).toEqual({ kind: "resume", toolResult: undefined, input: [user("next")] });
	});

	it("reseeds when an earlier user message was edited", () => {
		const seen = [user("read a.txt"), assistant("reading", ["call-1"]), toolResult("call-1", "body")];
		const edited = [user("read b.txt"), seen[1]!, seen[2]!];

		expect(planTurn([...edited, user("next")], ledgerFor(seen)).kind).toBe("fresh");
	});

	it("rewinds to the newest recorded turn end when an earlier message was edited", () => {
		const first = recordedTurn([user("one")], "conv-a");
		const second = recordedTurn([...first, user("two")], "conv-a");
		const edited = [...first, user("two, edited")];

		const plan = planTurn(edited, ledgerFor(second));

		expect(plan).toEqual({
			kind: "restore",
			conversationId: "conv-a",
			digest: transcriptDigest(first),
			checkpoint: { steps: 2, generations: 1, executions: 1 },
			replay: [user("two, edited")],
		});
	});

	it("does not resume a held call whose result is missing", () => {
		const seen = [user("read a.txt"), assistant("reading", ["call-1"])];

		const plan = planTurn([...seen, user("never mind")], ledgerFor(seen, "call-1"));

		expect(plan).toEqual({ kind: "fresh", replay: [...seen, user("never mind")] });
	});

	it("starts fresh from another provider's history with nothing recorded", () => {
		const foreign = [
			user("hi"),
			{ ...assistant("hello"), provider: "anthropic", api: "anthropic-messages" },
			user("go"),
		];

		expect(planTurn(foreign, undefined)).toEqual({ kind: "fresh", replay: foreign });
	});
});

describe("transcriptDigest", () => {
	it("covers user content, ordered tool call ids and names, result pairing and foreign assistant content", () => {
		const foreign = foreignAssistant("hello");
		const original = [user("read"), assistant("reading", ["a", "b"]), toolResult("a", "original"), foreign];
		const digest = transcriptDigest(original);
		const [ask, reading, body] = original;
		const renamed = assistant("reading", ["a", "b"]);
		const renamedCall = renamed.content[1];
		if (renamedCall?.type !== "toolCall") throw new Error("Missing test tool call");
		renamedCall.name = "write";
		const foreignCall = foreignAssistant("hello", ["x"]);
		const foreignArgs = foreignAssistant("hello", ["x"]);
		const call = foreignArgs.content[1];
		if (call?.type !== "toolCall") throw new Error("Missing test tool call");
		call.arguments = { path: "different" };
		const variants: [string, Message[]][] = [
			["user text", [user("edited"), reading!, body!, foreign]],
			["call order", [ask!, assistant("reading", ["b", "a"]), body!, foreign]],
			["call name", [ask!, renamed, body!, foreign]],
			["answered call", [ask!, reading!, toolResult("b", "original"), foreign]],
			["result tool name", [ask!, reading!, { ...toolResult("a", "original"), toolName: "write" }, foreign]],
			["foreign text", [ask!, reading!, body!, { ...foreign, content: [{ type: "text", text: "edited" }] }]],
		];
		for (const [name, variant] of variants) expect([name, transcriptDigest(variant)]).not.toEqual([name, digest]);
		expect(transcriptDigest([foreignCall])).not.toBe(transcriptDigest([foreignArgs]));
	});

	it("ignores content agy keeps its own copy of: result bodies, tool arguments and its own text and thinking", () => {
		const original = [user("read"), assistant("reading", ["a"]), toolResult("a", "token=hunter2")];
		const rewritten = assistant("", ["a"]);
		rewritten.content.push({ type: "thinking", thinking: "added" });
		const call = rewritten.content[1];
		if (call?.type !== "toolCall") throw new Error("Missing test tool call");
		call.arguments = { path: "[REDACTED]" };
		const redacted: ToolResultMessage = {
			...toolResult("a", "token=[REDACTED]"),
			isError: true,
			content: [{ type: "image", data: "YQ==", mimeType: "image/png" }],
		};
		expect(transcriptDigest([original[0]!, rewritten, redacted])).toBe(transcriptDigest(original));
	});

	it("ignores presentation metadata and object key insertion order", () => {
		const first = foreignAssistant("reading", ["a"]);
		const reordered = foreignAssistant("reading", ["a"]);
		const a = first.content[1];
		const b = reordered.content[1];
		if (a?.type !== "toolCall" || b?.type !== "toolCall") throw new Error("Missing test tool call");
		a.arguments = { path: "x", options: { first: 1, second: 2 } };
		b.arguments = { options: { second: 2, first: 1 }, path: "x" };
		reordered.timestamp = 999;
		reordered.duration = 12;
		reordered.usage.input = 999;
		const body = toolResult("a", "body");
		expect(transcriptDigest([first, body])).toBe(
			transcriptDigest([reordered, { ...body, details: { preview: "display" }, prunedAt: 123 }]),
		);
		b.arguments = { options: { second: 3, first: 1 }, path: "x" };
		expect(transcriptDigest([first, body])).not.toBe(transcriptDigest([reordered, body]));
	});

	it("includes image bytes and MIME types but not presentation URLs", () => {
		const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
		const first: UserMessage = { role: "user", timestamp: 0, content: [image] };
		expect(transcriptDigest([first])).not.toBe(
			transcriptDigest([{ ...first, content: [{ ...image, data: "Yg==" }] }]),
		);
		expect(transcriptDigest([first])).not.toBe(
			transcriptDigest([{ ...first, content: [{ ...image, mimeType: "image/jpeg" }] }]),
		);
		expect(transcriptDigest([user("same")])).toBe(
			transcriptDigest([{ ...user("same"), content: [{ type: "text", text: "same" }] }]),
		);
	});
});

describe("replayPrompt", () => {
	it("keeps historical user, assistant and tool-result images in content order", () => {
		const firstImage = { type: "image" as const, data: "dXNlcg==", mimeType: "image/png" };
		const secondImage = { type: "image" as const, data: "YXNzaXN0YW50", mimeType: "image/png" };
		const thirdImage = { type: "image" as const, data: "dG9vbA==", mimeType: "image/jpeg" };
		const reply = assistant("image response");
		reply.content.push(secondImage);
		const body = toolResult("a", "before");
		body.content.push(thirdImage, { type: "text", text: "after" });
		const blocks = replayPrompt([{ ...user(""), content: [firstImage] }, reply, body, user("continue")]);
		expect(blocks.filter(block => block.type === "image")).toEqual([firstImage, secondImage, thirdImage]);
		const imageIndex = blocks.findIndex(block => block.type === "image" && block.data === thirdImage.data);
		expect(blocks[imageIndex - 1]).toEqual({ type: "text", text: "before" });
		expect(blocks[imageIndex + 1]).toEqual({ type: "text", text: "after" });
	});

	it("preserves direct and delayed result text/image ordering", () => {
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const content = [{ type: "text" as const, text: "before" }, image, { type: "text" as const, text: "after" }];
		expect(inputBlocks({ role: "user", content, timestamp: 0 })).toEqual(content);
		const blocks = lateToolResultPrompt({ ...toolResult("a", ""), content });
		expect(blocks.slice(1, -1)).toEqual(content);
	});

	it("extracts only image blocks with a tool_result envelope for live MCP continuations", () => {
		expect(toolResultImagesPrompt(toolResult("call-1", "plain text"))).toEqual([]);
		const first = { type: "image" as const, data: "Zmlyc3Q=", mimeType: "image/jpeg" };
		const second = { type: "image" as const, data: "c2Vjb25k", mimeType: "image/png" };
		const mixed: ToolResultMessage = {
			...toolResult("call-2", "Read image file [image/jpeg]"),
			content: [
				{ type: "text", text: "Read image file [image/jpeg]" },
				first,
				{ type: "text", text: "note" },
				second,
			],
		};
		expect(toolResultImagesPrompt(mixed)).toEqual([
			{ type: "text", text: '<tool_result id="call-2" name="read">' },
			first,
			second,
			{ type: "text", text: "</tool_result>" },
		]);
		expect(toolResultImagesPrompt({ ...mixed, isError: true })[0]).toEqual({
			type: "text",
			text: '<tool_result id="call-2" name="read" error="true">',
		});
		const quoted = { ...mixed, toolCallId: 'call-"quoted"\\path', toolName: 'read "image"\nfile' };
		expect(toolResultImagesPrompt(quoted)[0]).toEqual({
			type: "text",
			text: `<tool_result id=${JSON.stringify(quoted.toolCallId)} name=${JSON.stringify(quoted.toolName)}>`,
		});
	});
	it("sends trailing user input as-is and labels earlier transcript messages", () => {
		const blocks = replayPrompt([
			user("read a.txt"),
			assistant("reading", ["call-1"]),
			toolResult("call-1", "FILE-BODY-42"),
			user("what did it say?"),
		]);

		const text = blocks.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(text).toContain("FILE-BODY-42");
		expect(text).toContain("read a.txt");
		expect(text).toContain('id="call-1"');
		expect(blocks.at(-1)).toEqual({ type: "text", text: "what did it say?" });
	});

	it("fits agy's prompt limit by dropping the oldest history while keeping the reminder first and input whole and last", () => {
		// 40 history messages of ~9 KB each: far beyond what agy keeps of one prompt.
		const history: Message[] = Array.from({ length: 40 }, (_, index) => {
			const text = `[h${index}] ${"x".repeat(9_000)}`;
			return index % 2 === 0 ? user(text) : assistant(text);
		});
		const reminder = `SYSTEM RULES ${"r".repeat(20_000)}`;
		const trailing = [user("first trailing request"), user(`newest request ${"y".repeat(30_000)}`)];

		const blocks = replayPrompt([...history, ...trailing], reminder);

		const texts = blocks.flatMap(block => (block.type === "text" ? [block.text] : []));
		const bytes = texts.reduce((total, text) => total + Buffer.byteLength(text), 0);
		expect(bytes).toBeLessThanOrEqual(AGY_PROMPT_BYTES);
		expect(blocks[0]).toEqual({ type: "text", text: `<system-reminder>\n${reminder}\n</system-reminder>` });
		expect(blocks.slice(-2)).toEqual(trailing.flatMap(message => inputBlocks(message)));
		const kept = [...texts.join("\n").matchAll(/\[h(\d+)\]/g)].map(match => Number(match[1]));
		const oldestKept = kept[0] ?? history.length;
		// Survivors are exactly the newest history messages, in order.
		expect(oldestKept).toBeGreaterThan(0);
		expect(oldestKept).toBeLessThan(history.length - 1);
		expect(kept).toEqual(Array.from({ length: history.length - oldestKept }, (_, index) => oldestKept + index));
		expect(texts.join("\n")).toContain(`<omitted messages="${oldestKept}">`);
	});

	it("cuts an oversized replayed tool result in the middle instead of dropping it", () => {
		// BEGIN/TAIL lengths put both cuts inside a 3-byte character.
		const body = `BEGIN${"€".repeat(40_000)}TAIL`;
		const blocks = replayPrompt([
			user("read big.txt"),
			assistant("reading", ["call-1"]),
			toolResult("call-1", body),
			user("summarize it"),
		]);

		const text = blocks.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		const clipped = blocks.find(block => block.type === "text" && block.text.startsWith("BEGIN"));
		if (clipped?.type !== "text") throw new Error("Tool result was dropped from the replay");
		expect(Buffer.byteLength(clipped.text)).toBeLessThanOrEqual(16 * 1024);
		expect(clipped.text).toMatch(/€\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n€/);
		expect(clipped.text.endsWith("TAIL")).toBe(true);
		expect(clipped.text).not.toContain("\uFFFD");
		expect(text).not.toContain("<omitted");
		expect(blocks.at(-1)).toEqual({ type: "text", text: "summarize it" });
	});
});
