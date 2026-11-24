/** Maps omp's per-step transcript onto one stateful agy turn. */
import { createHash } from "node:crypto";
import { prompt, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { ContentBlock } from "@oh-my-pi/pi-utils/acp";
import type {
	AntigravityCliCheckpoint,
	DeveloperMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "../../types";
import lateToolResultTemplate from "./late-tool-result.md" with { type: "text" };
import toolResultImagesTemplate from "./tool-result-images.md" with { type: "text" };
import transcriptTemplate from "./transcript.md" with { type: "text" };

/** The exact leading transcript represented by the live conversation. */
export interface Ledger {
	count: number;
	digest: string;
	pendingToolCallId?: string;
}

/** New user-side input for agy. */
export type InputMessage = UserMessage | DeveloperMessage;

export type TurnPlan =
	| { kind: "resume"; toolResult?: ToolResultMessage; input: InputMessage[] }
	| {
			kind: "restore";
			conversationId: string;
			digest: string;
			checkpoint: AntigravityCliCheckpoint;
			replay: Message[];
	  }
	| { kind: "fresh"; replay: Message[] };

/** Reuse only an exact visible prefix; otherwise fork a recorded turn end or reseed. */
export function planTurn(messages: readonly Message[], ledger: Ledger | undefined): TurnPlan {
	if (
		ledger &&
		messages.length > ledger.count &&
		transcriptDigest(messages.slice(0, ledger.count)) === ledger.digest
	) {
		// A user-interrupted step stays in agy's own trajectory; omp keeps only its partial text.
		const tail = messages
			.slice(ledger.count)
			.filter(message => !(message.role === "assistant" && message.stopReason === "aborted"));
		const first = tail[0];
		const toolResult =
			ledger.pendingToolCallId !== undefined &&
			first?.role === "toolResult" &&
			first.toolCallId === ledger.pendingToolCallId
				? first
				: undefined;
		const input = toolResult ? tail.slice(1) : tail;
		if ((ledger.pendingToolCallId === undefined || toolResult) && input.every(isInputMessage)) {
			return { kind: "resume", toolResult, input };
		}
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const payload = message.providerPayload;
		if (payload?.type !== "antigravityCli" || !payload.checkpoint) continue;
		if (transcriptDigest(messages.slice(0, index + 1)) !== payload.digest) continue;
		return {
			kind: "restore",
			conversationId: payload.conversationId,
			digest: payload.digest,
			checkpoint: payload.checkpoint,
			replay: messages.slice(index + 1),
		};
	}
	return { kind: "fresh", replay: [...messages] };
}

/**
 * Fingerprint the transcript's shape: user and developer content, tool call ids and names,
 * and which call each tool result answers. agy keeps its own copy of tool results, tool
 * arguments and its own steps, while omp rewrites those in place per request (secret
 * redaction, imaging, pruning), so their bytes would break continuation of a live turn.
 * Assistant messages from other providers keep their full content.
 */
export function transcriptDigest(messages: readonly Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(stableStringifyJson(messageContent(message)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

/**
 * Replay earlier turns as labelled text and image blocks, then send trailing input directly.
 * agy keeps only the first {@link AGY_PROMPT_BYTES} of a prompt and silently drops the rest,
 * so the trailing input and the optional first-message `reminder` are always kept whole and
 * history is dropped oldest first (oversized text parts are cut in the middle) to fit.
 */
export function replayPrompt(replay: readonly Message[], reminder?: string): ContentBlock[] {
	let split = replay.length;
	while (split > 0 && isInputMessage(replay[split - 1]!)) split--;
	const head: ContentBlock[] = reminder
		? [{ type: "text", text: `<system-reminder>\n${reminder}\n</system-reminder>` }]
		: [];
	const input = replay.slice(split).flatMap(message => (isInputMessage(message) ? inputBlocks(message) : []));
	if (split === 0) return [...head, ...input];
	const open: ContentBlock = { type: "text", text: prompt.render(transcriptTemplate, {}) };
	const close: ContentBlock = { type: "text", text: "</conversation-checkpoint>" };
	let budget =
		AGY_PROMPT_BYTES -
		PROMPT_RESERVE_BYTES -
		blockBytes(head) -
		blockBytes(input) -
		blockBytes([open, close]) -
		OMISSION_NOTE_BYTES;
	const kept: ContentBlock[][] = [];
	for (let index = split - 1; index >= 0; index--) {
		const blocks = historyBlocks(replay[index]!);
		const size = blockBytes(blocks);
		if (size > budget) break;
		budget -= size;
		kept.push(blocks);
	}
	kept.reverse();
	const omitted = split - kept.length;
	const note: ContentBlock[] =
		omitted > 0
			? [
					{
						type: "text",
						text: `<omitted messages="${omitted}">The ${omitted} oldest messages were dropped to fit the input limit.</omitted>`,
					},
				]
			: [];
	return [...head, open, ...note, ...kept.flat(), close, ...input];
}

/** agy truncates one prompt's text at this many UTF-8 bytes, keeping the start. */
export const AGY_PROMPT_BYTES = 192_000;
// agy wraps the prompt in `<USER_REQUEST>` and appends request metadata inside the same limit.
const PROMPT_RESERVE_BYTES = 4_096;
const OMISSION_NOTE_BYTES = 160;
// One replayed text part (usually a tool result) may take at most this much of the budget.
const MAX_REPLAYED_PART_BYTES = 16_384;
// Images travel as separate parts; this approximates their effect on the text budget.
const IMAGE_BLOCK_BYTES = 1_024;

function historyBlocks(message: Message): ContentBlock[] {
	const tag = message.role === "toolResult" ? "tool_result" : message.role;
	const attrs =
		message.role === "toolResult"
			? ` id=${JSON.stringify(message.toolCallId)} name=${JSON.stringify(message.toolName)} error=${message.isError}`
			: "";
	const blocks: ContentBlock[] = [{ type: "text", text: `<${tag}${attrs}>` }];
	if (typeof message.content === "string") blocks.push({ type: "text", text: clip(message.content) });
	else
		for (const part of message.content) {
			switch (part.type) {
				case "text":
					blocks.push({ type: "text", text: clip(part.text) });
					break;
				case "image":
					blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
					break;
				case "thinking":
					blocks.push({ type: "text", text: `<thinking>${clip(part.thinking)}</thinking>` });
					break;
				case "toolCall":
					blocks.push({
						type: "text",
						text: `<tool_call id=${JSON.stringify(part.id)} name=${JSON.stringify(part.name)}>${clip(stableStringifyJson(part.arguments))}</tool_call>`,
					});
					break;
			}
		}
	blocks.push({ type: "text", text: `</${tag}>` });
	return blocks;
}

/** Keep the start and end of an oversized replayed text, marking the cut. */
function clip(text: string): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= MAX_REPLAYED_PART_BYTES) return text;
	const keep = Math.floor((MAX_REPLAYED_PART_BYTES - 64) / 2);
	const start = bytes
		.subarray(0, keep)
		.toString()
		.replace(/\uFFFD+$/, "");
	const end = bytes
		.subarray(bytes.length - keep)
		.toString()
		.replace(/^\uFFFD+/, "");
	return `${start}\n[... ${bytes.length - 2 * keep} bytes omitted ...]\n${end}`;
}

function blockBytes(blocks: readonly ContentBlock[]): number {
	let total = 0;
	for (const block of blocks) total += block.type === "text" ? Buffer.byteLength(block.text) : IMAGE_BLOCK_BYTES;
	return total;
}

/** Supply the actual delayed result only after agy's old prompt has confirmed cancellation. */
export function lateToolResultPrompt(result: ToolResultMessage): ContentBlock[] {
	return [
		{
			type: "text",
			text: prompt.render(lateToolResultTemplate, {
				toolName: result.toolName,
				toolCallId: result.toolCallId,
				isError: result.isError,
			}),
		},
		...contentBlocks(result.content),
		{ type: "text", text: "</tool_result>" },
	];
}

/** Deliver MCP tool-result images as ACP prompt blocks because agy offloads MCP media to unexposed files. */
export function toolResultImagesPrompt(result: ToolResultMessage): ContentBlock[] {
	const images = result.content.filter((part): part is ImageContent => part.type === "image");
	if (images.length === 0) return [];
	return [
		{
			type: "text",
			text: prompt.render(toolResultImagesTemplate, {
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				isError: result.isError,
			}),
		},
		...contentBlocks(images),
		{ type: "text", text: "</tool_result>" },
	];
}

/** ACP input preserves text/image ordering and the complete image bytes. */
export function inputBlocks(message: InputMessage): ContentBlock[] {
	return contentBlocks(message.content);
}

/** Whether a transcript message can be sent directly as ACP user input. */
export function isInputMessage(message: Message): message is InputMessage {
	return message.role === "user" || message.role === "developer";
}

function contentBlocks(content: string | readonly (TextContent | ImageContent)[]): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map(part =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
}

function messageContent(message: Message): unknown {
	switch (message.role) {
		case "toolResult":
			return { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName };
		case "assistant":
			if (message.api === "antigravity-acp")
				return {
					role: message.role,
					toolCalls: message.content.flatMap(part =>
						part.type === "toolCall" ? [{ id: part.id, name: part.name }] : [],
					),
				};
			break;
	}
	const content =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.flatMap((part): unknown[] => {
					switch (part.type) {
						case "text":
							return [{ type: part.type, text: part.text }];
						case "image":
							return [{ type: part.type, data: part.data, mimeType: part.mimeType }];
						case "thinking":
							return [{ type: part.type, thinking: part.thinking }];
						case "toolCall":
							return [{ type: part.type, id: part.id, name: part.name, arguments: part.arguments }];
						// Opaque blocks from other providers are not sent to agy.
						default:
							return [];
					}
				});
	return { role: message.role, content };
}
