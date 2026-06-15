import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import {
	ensureKnowledgeDescriptionContent,
	getKnowledgeRoot,
	knowledgeUrlForPath,
	loadKnowledgeSummaries,
	normalizeKnowledgePath,
} from "../session/knowledge-index";
import { parseInternalUrl } from "./parse";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
	WriteResult,
} from "./types";

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("knowledge:// URL escapes knowledge root");
	}
}

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

function cwdFromRegistry(): string | undefined {
	const main = AgentRegistry.global()
		.list()
		.find(ref => ref.kind === "main");
	return main?.session?.sessionManager?.getCwd();
}

function resolveKnowledgeCwd(context?: ResolveContext | WriteContext): string {
	const cwd = context?.cwd ?? cwdFromRegistry();
	if (!cwd) {
		throw new Error("knowledge:// requires a session cwd");
	}
	return path.resolve(cwd);
}

function decodeKnowledgeSegment(value: string, label: string, url: InternalUrl): string {
	try {
		return decodeURIComponent(value.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in knowledge:// ${label}: ${url.href}`);
	}
}

function normalizeKnowledgeCategory(category: string): string | undefined {
	const probe = normalizeKnowledgePath(`${category}/index.md`);
	return probe ? probe.slice(0, -"/index.md".length) : undefined;
}

interface ParsedKnowledgeUrlPath {
	category?: string;
	relativePath?: string;
}

function parseKnowledgeUrlPath(url: InternalUrl): ParsedKnowledgeUrlPath {
	const rawCategory = url.rawHost || url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";

	if (!rawCategory) {
		if (!hasPath) return {};
		const relativePath = decodeKnowledgeSegment(rawPathname.slice(1), "path", url);
		const normalized = normalizeKnowledgePath(relativePath);
		if (!normalized) {
			throw new Error("knowledge:// path must be <category>/<topic>.md");
		}
		return { category: normalized.split("/")[0], relativePath: normalized };
	}

	const category = decodeKnowledgeSegment(rawCategory, "category", url);
	const normalizedCategory = normalizeKnowledgeCategory(category);
	if (!normalizedCategory) {
		throw new Error("knowledge:// category must be a non-hidden relative path segment");
	}

	if (!hasPath) {
		return { category: normalizedCategory };
	}

	const topicPath = decodeKnowledgeSegment(rawPathname.slice(1), "path", url);
	const normalized = normalizeKnowledgePath(`${normalizedCategory}/${topicPath}`);
	if (!normalized) {
		throw new Error("knowledge:// path must be <category>/<topic>.md");
	}
	return { category: normalizedCategory, relativePath: normalized };
}

export function resolveKnowledgeUrlToPath(input: string | InternalUrl, cwd: string): string {
	const url = typeof input === "string" ? parseInternalUrl(input) : input;
	const root = path.resolve(getKnowledgeRoot(cwd));
	const parsed = parseKnowledgeUrlPath(url);
	if (parsed.relativePath) {
		return path.resolve(root, ...parsed.relativePath.split("/"));
	}
	if (parsed.category) {
		return path.resolve(root, parsed.category);
	}
	return root;
}

async function buildListing(url: InternalUrl, cwd: string, category?: string): Promise<InternalResource> {
	const summaries = await loadKnowledgeSummaries({ cwd });
	const visible = category ? summaries.filter(summary => summary.category === category) : summaries;
	const title = category ? `# Knowledge: ${category}` : "# Knowledge";
	const body =
		visible.length === 0
			? category
				? `No project knowledge files in category \`${category}\`.`
				: "No project knowledge files."
			: visible
					.map(summary => `- [${summary.path}](${knowledgeUrlForPath(summary.path)}) - ${summary.description}`)
					.join("\n");
	const content = `${title}\n\n${body}\n`;
	// Expose the backing directory so search/find/ast_* can scope into it; read
	// keeps rendering `content` (the curated listing), since sourcePath is metadata
	// for those callers, not the read body.
	const root = path.resolve(getKnowledgeRoot(cwd));
	const sourcePath = category ? path.resolve(root, category) : root;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath,
		immutable: true,
	};
}

async function readKnowledgeFile(url: InternalUrl, cwd: string, relativePath: string): Promise<InternalResource> {
	const root = path.resolve(getKnowledgeRoot(cwd));
	let realRoot: string;
	try {
		realRoot = await fs.realpath(root);
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Knowledge file not found: ${url.href}`);
		}
		throw error;
	}

	const targetPath = path.resolve(realRoot, ...relativePath.split("/"));
	ensureWithinRoot(targetPath, realRoot);

	const parentDir = path.dirname(targetPath);
	try {
		const realParent = await fs.realpath(parentDir);
		ensureWithinRoot(realParent, realRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Knowledge file not found: ${url.href}`);
		}
		throw error;
	}

	ensureWithinRoot(realTargetPath, realRoot);
	const stat = await fs.stat(realTargetPath);
	if (!stat.isFile()) {
		throw new Error(`knowledge:// URL must resolve to a file: ${url.href}`);
	}

	const content = await Bun.file(realTargetPath).text();
	return {
		url: url.href,
		content,
		contentType: getContentType(realTargetPath),
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: realTargetPath,
		notes: ["Use write path knowledge://<category>/<topic>.md to update project knowledge."],
	};
}

async function writeKnowledgeFile(cwd: string, relativePath: string, content: string): Promise<WriteResult> {
	if (content.trim().length === 0) {
		throw new Error("Knowledge content cannot be empty.");
	}

	const root = path.resolve(getKnowledgeRoot(cwd));
	await fs.mkdir(root, { recursive: true });
	const realRoot = await fs.realpath(root);
	const targetPath = path.resolve(realRoot, ...relativePath.split("/"));
	ensureWithinRoot(targetPath, realRoot);

	const parentDir = path.dirname(targetPath);
	await fs.mkdir(parentDir, { recursive: true });
	const realParent = await fs.realpath(parentDir);
	ensureWithinRoot(realParent, realRoot);

	try {
		const realTarget = await fs.realpath(targetPath);
		ensureWithinRoot(realTarget, realRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let finalContent = ensureKnowledgeDescriptionContent(relativePath, content).content.replace(/\r\n?/g, "\n");
	if (!finalContent.endsWith("\n")) finalContent += "\n";
	await Bun.write(targetPath, finalContent);
	return {
		text: `Wrote knowledge://${relativePath} (${Buffer.byteLength(finalContent, "utf-8")} bytes).`,
	};
}

/**
 * Protocol handler for project-local knowledge:// URLs.
 *
 * URL forms:
 * - knowledge:// - Lists project knowledge files
 * - knowledge://<category> - Lists files in one category
 * - knowledge://<category>/<topic>.md - Reads or writes one knowledge file
 */
export class KnowledgeProtocolHandler implements ProtocolHandler {
	readonly scheme = "knowledge";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const cwd = resolveKnowledgeCwd(context);
		const parsed = parseKnowledgeUrlPath(url);
		if (!parsed.relativePath) {
			return buildListing(url, cwd, parsed.category);
		}
		return readKnowledgeFile(url, cwd, parsed.relativePath);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<WriteResult> {
		if (context?.allowKnowledgeWrite !== true) {
			throw new Error(
				"knowledge:// is read-only in this session; project knowledge is maintained by the knowledge pass (/knowledge compact).",
			);
		}
		const cwd = resolveKnowledgeCwd(context);
		const parsed = parseKnowledgeUrlPath(url);
		if (!parsed.relativePath) {
			throw new Error("knowledge:// write requires a file path: knowledge://<category>/<topic>.md");
		}
		return writeKnowledgeFile(cwd, parsed.relativePath, content);
	}
}
