import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Message, MessageAttribution, Model, Tool } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
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

function parseKnowledgeResponse(text: string): KnowledgeExtractionResponse {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return {};
	const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
	if (!parsed || typeof parsed !== "object") return {};
	const record = parsed as { files?: unknown };
	if (!Array.isArray(record.files)) return {};
	const files: KnowledgeFileUpdate[] = [];
	for (const item of record.files) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as { path?: unknown; content?: unknown };
		if (typeof candidate.path !== "string" || typeof candidate.content !== "string") continue;
		files.push({ path: candidate.path, content: candidate.content });
	}
	return { files };
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
		const response = await ai.completeSimple(
			options.model,
			{
				systemPrompt: outboundSystemPrompt,
				messages: outboundMessages,
				tools: options.tools && options.tools.length > 0 ? [...options.tools] : undefined,
			},
			{
				maxTokens: 4096,
				signal: options.signal,
				apiKey: options.apiKey,
				reasoning,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
				toolChoice: options.tools && options.tools.length > 0 ? "none" : undefined,
			},
		);
		if (response.stopReason === "error") {
			logger.debug("Session knowledge extraction failed", { error: response.errorMessage });
			return undefined;
		}
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const parsed = parseKnowledgeResponse(text);
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
