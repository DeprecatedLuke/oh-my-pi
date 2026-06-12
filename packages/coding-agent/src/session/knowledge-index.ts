import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const MAX_KNOWLEDGE_DESCRIPTION_CHARS = 512;
const MAX_KNOWLEDGE_DESCRIPTION_TAGS = 32;

export interface KnowledgeSummary {
	category: string;
	topic: string;
	path: string;
	description: string;
}

export interface LoadKnowledgeSummariesOptions {
	cwd: string;
	autoUpdate?: boolean;
}

interface ParsedKnowledgeContent {
	frontmatter: Record<string, unknown>;
	body: string;
	canRewrite: boolean;
}

export function getKnowledgeRoot(cwd: string): string {
	return path.join(cwd, ".omp", "knowledge");
}

export function normalizeKnowledgePath(relativePath: string): string | undefined {
	const normalized = relativePath.replaceAll("\\", "/").trim();
	const parts = normalized.split("/");
	if (parts.length !== 2) return undefined;
	const [category, fileName] = parts;
	if (!category || !fileName || category === "." || category === ".." || fileName === "." || fileName === "..") {
		return undefined;
	}
	if (category.startsWith(".") || fileName.startsWith(".")) return undefined;
	if (!fileName.toLowerCase().endsWith(".md")) return undefined;
	if (category.includes("\0") || fileName.includes("\0")) return undefined;
	return `${category}/${fileName}`;
}

export function knowledgeUrlForPath(relativePath: string): string {
	const normalized = normalizeKnowledgePath(relativePath);
	if (!normalized) {
		throw new Error(`Invalid knowledge path: ${relativePath}`);
	}
	return `knowledge://${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

async function collectKnowledgeMarkdownFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
	let entries: nodeFs.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return out;
		throw error;
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectKnowledgeMarkdownFiles(root, fullPath, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
		out.push(path.relative(root, fullPath).replaceAll(path.sep, "/"));
	}
	return out;
}

function hasDelimitedFrontmatter(content: string): boolean {
	return content.startsWith("---\n") && content.indexOf("\n---", 4) !== -1;
}

function parseKnowledgeContent(relativePath: string, content: string): ParsedKnowledgeContent {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (normalized.startsWith("---") && !hasDelimitedFrontmatter(normalized)) {
		return { frontmatter: {}, body: normalized.trim(), canRewrite: false };
	}
	if (!hasDelimitedFrontmatter(normalized)) {
		return { frontmatter: {}, body: normalized.trim(), canRewrite: true };
	}
	const { frontmatter, body } = parseFrontmatter(normalized, { source: relativePath });
	return { frontmatter, body: body.trim(), canRewrite: true };
}

function frontmatterString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function trimKnowledgeDescription(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_KNOWLEDGE_DESCRIPTION_CHARS) return normalized;
	const breakIndex = normalized.lastIndexOf(" ", MAX_KNOWLEDGE_DESCRIPTION_CHARS - 1);
	const end = breakIndex >= 64 ? breakIndex : MAX_KNOWLEDGE_DESCRIPTION_CHARS - 1;
	return `${normalized.slice(0, end).trimEnd()}…`;
}

function stripMarkdownLine(line: string): string {
	return line
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^>\s?/, "")
		.replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
		.replace(/[*_~`]/g, "")
		.trim();
}

function humanizeTopic(relativePath: string): string {
	const topic = path.basename(relativePath, ".md").replace(/[-_]+/g, " ").trim();
	if (!topic) return "project knowledge note";
	return topic.toLowerCase();
}

function normalizeKnowledgeTag(text: string): string | undefined {
	const tag = text
		.replace(/^(?:remember that|note that|run|use|keep|prefer|ensure|store|stores|record|records)\s+/i, "")
		.replace(/\b(?:must be|should be|needs to be|is|are|was|were|be|being|been)\s+[\p{L}-]+$/iu, "")
		.replace(/^[\s,.:;!?()[\]{}"'“”‘’]+|[\s,.:;!?()[\]{}"'“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!tag || tag.length < 2) return undefined;
	return trimKnowledgeDescription(tag);
}

function addKnowledgeTag(tags: string[], seen: Set<string>, candidate: string | undefined): void {
	if (tags.length >= MAX_KNOWLEDGE_DESCRIPTION_TAGS || !candidate) return;
	const tag = normalizeKnowledgeTag(candidate);
	if (!tag) return;
	const key = tag.toLowerCase();
	if (seen.has(key)) return;
	seen.add(key);
	tags.push(tag);
}

function splitKnowledgeTagLine(line: string): string[] {
	return stripMarkdownLine(line)
		.split(
			/\b(?:after|before|during|for|when|with|without|because|while|via|using|from|into|under|inside|outside|rather than|instead of)\b/iu,
		)
		.map(part => part.trim())
		.filter(Boolean);
}

function isTagBasedDescription(description: string): boolean {
	const trimmed = description.trim();
	if (!trimmed) return false;
	if (trimmed.includes(",")) return true;
	return (
		trimmed.length <= 48 &&
		!/[.!?]$/.test(trimmed) &&
		!/\b(?:is|are|was|were|must|should|needs?|contains?|stores?|uses?|requires?|supports?|prevents?|suppresses?|records?|updates?|creates?|deletes?|migrates?|runs?)\b/i.test(
			trimmed,
		)
	);
}

export function deriveKnowledgeDescription(relativePath: string, body: string): string {
	const tags: string[] = [];
	const seen = new Set<string>();
	const [category] = relativePath.split("/");
	addKnowledgeTag(tags, seen, category);
	addKnowledgeTag(tags, seen, humanizeTopic(relativePath));

	let inFence = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("```") || line.startsWith("~~~")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (/^#{1,6}\s+/.test(line)) {
			addKnowledgeTag(tags, seen, stripMarkdownLine(line));
			continue;
		}
		for (const tag of splitKnowledgeTagLine(line)) {
			addKnowledgeTag(tags, seen, tag);
		}
		if (tags.length >= MAX_KNOWLEDGE_DESCRIPTION_TAGS) break;
	}

	return tags.length > 0 ? trimKnowledgeDescription(tags.join(", ")) : humanizeTopic(relativePath);
}

function serializeKnowledgeContent(frontmatter: Record<string, unknown>, body: string): string {
	const metadata = YAML.stringify(frontmatter, null, 2).trimEnd();
	const trimmedBody = body.trim();
	return trimmedBody.length > 0 ? `---\n${metadata}\n---\n\n${trimmedBody}\n` : `---\n${metadata}\n---\n`;
}

export function ensureKnowledgeDescriptionContent(
	relativePath: string,
	content: string,
): { content: string; description: string; changed: boolean } {
	const parsed = parseKnowledgeContent(relativePath, content);
	const existingDescription = frontmatterString(parsed.frontmatter.description);
	if (existingDescription && isTagBasedDescription(existingDescription)) {
		return { content, description: trimKnowledgeDescription(existingDescription), changed: false };
	}

	const legacySummary = frontmatterString(parsed.frontmatter.summary);
	const description =
		legacySummary && isTagBasedDescription(legacySummary)
			? trimKnowledgeDescription(legacySummary)
			: deriveKnowledgeDescription(relativePath, parsed.body || legacySummary || "");
	if (!parsed.canRewrite) return { content, description, changed: false };

	const nextContent = serializeKnowledgeContent({ ...parsed.frontmatter, description }, parsed.body);
	return { content: nextContent, description, changed: nextContent !== content.replace(/\r\n?/g, "\n") };
}

export async function loadKnowledgeSummaries(options: LoadKnowledgeSummariesOptions): Promise<KnowledgeSummary[]> {
	const root = getKnowledgeRoot(options.cwd);
	const files = await collectKnowledgeMarkdownFiles(root);
	const summaries: KnowledgeSummary[] = [];

	for (const relativeFile of files) {
		const relativePath = normalizeKnowledgePath(relativeFile);
		if (!relativePath) continue;
		const fullPath = path.join(root, ...relativePath.split("/"));
		try {
			const content = await Bun.file(fullPath).text();
			const ensured = ensureKnowledgeDescriptionContent(relativePath, content);
			if (options.autoUpdate !== false && ensured.changed) {
				await Bun.write(fullPath, ensured.content);
			}
			const [category, topic] = relativePath.split("/") as [string, string];
			summaries.push({ category, topic, path: relativePath, description: ensured.description });
		} catch (error) {
			logger.warn("Failed to load knowledge summary", {
				path: relativePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	summaries.sort((a, b) => a.category.localeCompare(b.category) || a.topic.localeCompare(b.topic));
	return summaries;
}

export async function fingerprintKnowledgeRoot(cwd: string): Promise<string> {
	const root = getKnowledgeRoot(cwd);
	const files = await collectKnowledgeMarkdownFiles(root);
	const hasher = new Bun.SHA256();
	hasher.update("omp-knowledge-root-v1\0");

	for (const relativeFile of files) {
		const relativePath = normalizeKnowledgePath(relativeFile);
		if (!relativePath) continue;
		const fullPath = path.join(root, ...relativePath.split("/"));
		try {
			const content = await Bun.file(fullPath).text();
			hasher.update(`${relativePath.length}:${relativePath}\0${Buffer.byteLength(content, "utf8")}:\0`);
			hasher.update(content);
			hasher.update("\0");
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
	}

	return hasher.digest("hex");
}
