import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Message, MessageAttribution, Model, Tool } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall } from "../commit/utils";
import sessionKnowledgeTemplate from "../prompts/system/session-knowledge.md" with { type: "text" };
import { obfuscateMessages, type SecretObfuscator } from "../secrets/obfuscator";
import { ensureKnowledgeDescriptionContent, normalizeKnowledgePath } from "./knowledge-index";

const MAX_EXISTING_FILES = 80;
const MAX_EXISTING_BYTES = 120_000;

interface ExistingKnowledgeFile {
	path: string;
	content: string;
}

interface KnowledgeFileUpdate {
	path: string;
	content: string;
}

interface KnowledgeExtractionResponse {
	files?: KnowledgeFileUpdate[];
}

export interface WriteSessionKnowledgeOptions {
	cwd: string;
	model: Model;
	apiKey: string;
	baseSystemPrompt: string[];
	sourceTitle: string;
	messages: readonly Message[];
	tools?: readonly Tool[];
	signal?: AbortSignal;
	metadata?: Record<string, unknown>;
	initiatorOverride?: MessageAttribution;
	obfuscator?: SecretObfuscator;
}

export interface WriteSessionKnowledgeResult {
	written: string[];
	skipped: number;
}

function truncateText(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > maxBytes) break;
		bytes += charBytes;
		end += char.length;
	}
	return `${text.slice(0, end)}\n\n[... truncated for knowledge extraction ...]`;
}

async function collectMarkdownFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
	let entries: nodeFs.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return out;
		throw error;
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectMarkdownFiles(root, fullPath, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
		out.push(path.relative(root, fullPath).replaceAll(path.sep, "/"));
	}
	return out;
}

async function loadExistingKnowledge(root: string): Promise<ExistingKnowledgeFile[]> {
	const files = (await collectMarkdownFiles(root)).slice(0, MAX_EXISTING_FILES);
	const result: ExistingKnowledgeFile[] = [];
	let remainingBytes = MAX_EXISTING_BYTES;

	for (const relativeFile of files) {
		if (remainingBytes <= 0) break;
		const relativePath = normalizeKnowledgePath(relativeFile);
		if (!relativePath) continue;
		const fullPath = path.join(root, ...relativePath.split("/"));
		const content = await Bun.file(fullPath).text();
		const ensured = ensureKnowledgeDescriptionContent(relativePath, content);
		if (ensured.changed) {
			await Bun.write(fullPath, ensured.content);
		}
		const truncated = truncateText(ensured.content, remainingBytes);
		remainingBytes -= Buffer.byteLength(truncated, "utf8");
		result.push({ path: relativePath, content: truncated });
	}
	return result;
}

function renderExistingKnowledge(files: ExistingKnowledgeFile[]): string {
	if (files.length === 0) return "No existing knowledge files.";
	return files.map(file => `<file path="${file.path}">\n${file.content}\n</file>`).join("\n\n");
}

function buildKnowledgePrompt(options: WriteSessionKnowledgeOptions, existingFiles: ExistingKnowledgeFile[]): string {
	return prompt.render(sessionKnowledgeTemplate, {
		existingKnowledge: renderExistingKnowledge(existingFiles),
		sourceTitle: options.sourceTitle,
	});
}
function resolveKnowledgeReasoning(model: Model): ai.Effort | undefined {
	if (!model.reasoning) return undefined;
	try {
		return clampThinkingLevelForModel(model, ai.Effort.Minimal);
	} catch (error) {
		logger.debug("Session knowledge reasoning disabled", {
			provider: model.provider,
			model: model.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

const KNOWLEDGE_TOOL_NAME = "save_knowledge";
const KNOWLEDGE_EXTRACTION_ATTEMPTS = 3;

// Forced-tool extraction: the model returns the knowledge files as structured
// tool arguments (provider-parsed JSON) instead of free-form text, so a long
// extraction no longer truncates mid-JSON and dies in `JSON.parse`. Anthropic
// strips thinking automatically when a tool is forced; models that reject a
// forced choice downgrade it to "auto" (see anthropic provider), which is why
// `extractKnowledgeFiles` keeps a prose fallback.
const knowledgeTool: Tool = {
	name: KNOWLEDGE_TOOL_NAME,
	description:
		"Persist the durable project knowledge extracted from this session. Call exactly once; pass an empty `files` array when the session yields nothing worth saving.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["files"],
		properties: {
			files: {
				type: "array",
				description: "Knowledge files to create or overwrite. Empty when nothing durable was learned.",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["path", "content"],
					properties: {
						path: {
							type: "string",
							description: "Path as <category>/<topic>.md, relative to .omp/knowledge.",
						},
						content: {
							type: "string",
							description:
								"Full markdown file content, starting with YAML frontmatter whose `description` is comma-separated retrieval tags.",
						},
					},
				},
			},
		},
	},
	strict: false,
};

function coerceKnowledgeFiles(filesValue: unknown): KnowledgeFileUpdate[] {
	if (!Array.isArray(filesValue)) return [];
	const files: KnowledgeFileUpdate[] = [];
	for (const item of filesValue) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as { path?: unknown; content?: unknown };
		if (typeof candidate.path !== "string" || typeof candidate.content !== "string") continue;
		files.push({ path: candidate.path, content: candidate.content });
	}
	return files;
}

function parseKnowledgeToolArguments(args: Record<string, unknown> | undefined): KnowledgeExtractionResponse {
	if (!args || typeof args !== "object") return {};
	const filesValue = (args as { files?: unknown }).files;
	if (!Array.isArray(filesValue)) return {};
	return { files: coerceKnowledgeFiles(filesValue) };
}

// Salvage `{ "files": [...] }` from a prose response — used only when a model
// answered in text after downgrading the forced tool choice to "auto".
function parseKnowledgeResponse(text: string): KnowledgeExtractionResponse {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const filesValue = (parsed as { files?: unknown }).files;
	if (!Array.isArray(filesValue)) return {};
	return { files: coerceKnowledgeFiles(filesValue) };
}

interface KnowledgeExtractionParams {
	model: Model;
	context: ai.Context;
	options: ai.SimpleStreamOptions;
	signal?: AbortSignal;
	sourceTitle: string;
}

// Run the extraction with bounded retries. Returns the parsed files (possibly
// empty when the model deliberately saved nothing) or `undefined` when every
// attempt errored/aborted, which the caller surfaces as a failed export.
async function extractKnowledgeFiles(
	params: KnowledgeExtractionParams,
): Promise<KnowledgeExtractionResponse | undefined> {
	const { model, context, options, signal, sourceTitle } = params;
	let lastError: string | undefined;
	for (let attempt = 1; attempt <= KNOWLEDGE_EXTRACTION_ATTEMPTS; attempt++) {
		if (signal?.aborted) return undefined;
		let response: AssistantMessage;
		try {
			response = await ai.completeSimple(model, context, options);
		} catch (error) {
			if (signal?.aborted) return undefined;
			lastError = error instanceof Error ? error.message : String(error);
			logger.debug("Session knowledge extraction attempt threw", { sourceTitle, attempt, error: lastError });
			continue;
		}
		if (response.stopReason === "aborted") return undefined;
		if (response.stopReason === "error") {
			lastError = response.errorMessage ?? "provider error";
			logger.debug("Session knowledge extraction attempt errored", { sourceTitle, attempt, error: lastError });
			continue;
		}
		const toolCall = extractToolCall(response, KNOWLEDGE_TOOL_NAME);
		if (toolCall) return parseKnowledgeToolArguments(toolCall.arguments);
		const fromText = parseKnowledgeResponse(extractTextContent(response));
		if (fromText.files) return fromText;
		lastError = "no knowledge tool call in response";
		logger.debug("Session knowledge extraction attempt had no tool call", { sourceTitle, attempt });
	}
	logger.debug("Session knowledge extraction exhausted retries", { sourceTitle, error: lastError });
	return undefined;
}

async function applyKnowledgeUpdates(
	root: string,
	updates: KnowledgeFileUpdate[],
): Promise<WriteSessionKnowledgeResult> {
	const written: string[] = [];
	let skipped = 0;

	for (const update of updates) {
		const relativePath = normalizeKnowledgePath(update.path);
		if (!relativePath || !update.content.trim()) {
			skipped += 1;
			continue;
		}
		const fullPath = path.join(root, ...relativePath.split("/"));
		const resolvedRoot = path.resolve(root);
		const resolvedPath = path.resolve(fullPath);
		if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
			skipped += 1;
			continue;
		}

		const ensured = ensureKnowledgeDescriptionContent(relativePath, update.content);
		const nextContent = ensured.content.endsWith("\n") ? ensured.content : `${ensured.content}\n`;
		let currentContent: string | undefined;
		try {
			currentContent = await Bun.file(fullPath).text();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (currentContent === nextContent) {
			skipped += 1;
			continue;
		}

		await Bun.write(fullPath, nextContent);
		written.push(relativePath);
	}

	return { written, skipped };
}

export async function writeSessionKnowledge(
	options: WriteSessionKnowledgeOptions,
): Promise<WriteSessionKnowledgeResult | undefined> {
	if (options.messages.length === 0) return undefined;
	const root = path.join(options.cwd, ".omp", "knowledge");
	try {
		const existingFiles = await loadExistingKnowledge(root);
		const promptText = buildKnowledgePrompt(options, existingFiles);
		const instructionMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		const masker = options.obfuscator?.hasSecrets() ? options.obfuscator : undefined;
		// Mask secrets out of the entire outbound extraction request — the base
		// system prompt, the conversation messages, and the instruction prompt
		// (which embeds raw existing knowledge-file content). Unmask-then-mask
		// keeps the transform idempotent regardless of whether inputs arrive raw
		// or already masked.
		const outboundSystemPrompt = masker
			? options.baseSystemPrompt.map(block => masker.obfuscate(masker.deobfuscate(block)))
			: options.baseSystemPrompt;
		const outboundMessages = masker
			? obfuscateMessages(masker, masker.deobfuscateObject([...options.messages, instructionMessage]))
			: [...options.messages, instructionMessage];
		logger.debug("Session knowledge update started", {
			sourceTitle: options.sourceTitle,
			messageCount: options.messages.length,
		});
		const reasoning = resolveKnowledgeReasoning(options.model);
		const sessionTools = options.tools && options.tools.length > 0 ? options.tools : [];
		const tools = [...sessionTools, knowledgeTool];
		const parsed = await extractKnowledgeFiles({
			model: options.model,
			context: {
				systemPrompt: outboundSystemPrompt,
				messages: outboundMessages,
				tools,
			},
			options: {
				signal: options.signal,
				apiKey: options.apiKey,
				reasoning,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
				toolChoice: { type: "tool", name: KNOWLEDGE_TOOL_NAME },
			},
			signal: options.signal,
			sourceTitle: options.sourceTitle,
		});
		if (!parsed) return undefined;
		if (!parsed.files || parsed.files.length === 0) {
			logger.debug("Session knowledge update complete", {
				sourceTitle: options.sourceTitle,
				written: 0,
				skipped: 0,
			});
			return { written: [], skipped: 0 };
		}
		// Restore real secrets before persisting so `.omp/knowledge` stays raw at
		// rest (like raw session messages); the loader re-masks the content when
		// it is folded back into the outbound system prompt.
		const updates = masker
			? parsed.files.map(file => ({
					path: masker.deobfuscate(file.path),
					content: masker.deobfuscate(file.content),
				}))
			: parsed.files;
		const result = await applyKnowledgeUpdates(root, updates);
		logger.debug("Session knowledge update complete", {
			sourceTitle: options.sourceTitle,
			written: result.written.length,
			skipped: result.skipped,
		});
		return result;
	} catch (error) {
		if (options.signal?.aborted) return undefined;
		logger.debug("Failed to update session knowledge", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
