/**
 * Protocol handler for project-local `issues://` URLs.
 *
 * URL shapes:
 * - `issues://` — list active issues, grouped by category
 * - `issues://archive` — list archived issues
 * - `issues://?q=<text>` — keyword filter against title/body/frontmatter
 * - `issues://<filename>.md` — read or **edit** a specific issue file by basename
 * - `issues://<id>` / `issues://<id>.md` — read or edit by global id
 * - `issues://<id>-<slug>` / `issues://<id>-<slug>.md` — same; slug is
 *   accepted as a hint but not required for lookup
 *
 * Individual issue files are writable through the `edit`/`write` tools so
 * body changes go through the normal editing surface. Lifecycle and
 * metadata mutations (status-driven archive moves, slug renames, category
 * moves) live in the `issues` tool so ID allocation and structured
 * details stay in one place; raw writes to listing URLs (`issues://`,
 * `issues://archive`) are rejected.
 */
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { findIssueByFilename, getIssuesRoot, listIssues, renderIssueListing } from "../issues";
import { AgentRegistry } from "../registry/agent-registry";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
	WriteResult,
} from "./types";

function cwdFromRegistry(): string | undefined {
	const main = AgentRegistry.global()
		.list()
		.find(ref => ref.kind === "main");
	return main?.session?.sessionManager?.getCwd();
}

function resolveIssuesCwd(context?: ResolveContext): string {
	const cwd = context?.cwd ?? cwdFromRegistry();
	if (!cwd) throw new Error("issues:// requires a session cwd");
	return cwd;
}

interface ParsedIssueUrl {
	kind: "list" | "archive-list" | "file";
	basename?: string;
}

function parseIssuesUrl(url: InternalUrl): ParsedIssueUrl {
	const host = (url.rawHost || url.hostname).toLowerCase();
	const rawPath = url.rawPathname ?? url.pathname;
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const parts: string[] = [];
	if (stripped !== "") {
		for (const seg of stripped.split("/")) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(seg);
			} catch {
				throw new Error(`Invalid issues:// URL: ${url.href}`);
			}
			if (decoded === "." || decoded === "..") {
				throw new Error("Invalid issues:// URL: traversal segments rejected");
			}
			parts.push(decoded);
		}
	}

	if (!host && parts.length === 0) {
		return { kind: "list" };
	}
	if (host === "archive" && parts.length === 0) {
		return { kind: "archive-list" };
	}
	if (parts.length === 0) {
		return { kind: "file", basename: host };
	}
	throw new Error(
		`Invalid issues:// URL. Expected issues://, issues://archive, or issues://<filename>.md (got: ${url.href})`,
	);
}

async function buildListing(url: InternalUrl, cwd: string, archived: boolean): Promise<InternalResource> {
	const query = url.searchParams.get("q") ?? undefined;
	const summaries = await listIssues(cwd, { archived, query });
	const titleScope = archived ? "Archived Issues" : "Issues";
	const queryNote = query ? ` matching "${query}"` : "";
	const title = `# ${titleScope}${queryNote} (${summaries.length})`;
	const emptyText = query
		? `_No issues match "${query}"._`
		: archived
			? "_No archived issues._"
			: "_No issues. Use the `issues` tool with `op: add` to create one._";

	const body = renderIssueListing(summaries, { title, emptyText, group: true });
	const footer = archived
		? "\n\nUse `issues://` for active issues. Edit a body via the `edit` tool on `issues://<id>.md`; status/lifecycle via the `issues` tool."
		: "\n\nUse `issues://archive` for archived issues. Edit a body via the `edit` tool on `issues://<id>.md`; status/lifecycle via the `issues` tool.";
	const content = `${body}${footer}`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		immutable: true,
		notes: ["Issues listing — read individual files via `issues://<filename>.md`."],
	};
}

async function readIssueFile(url: InternalUrl, cwd: string, basename: string): Promise<InternalResource> {
	const record = await findIssueByFilename(cwd, basename);
	if (!record) {
		throw new Error(
			`Issue not found: ${basename}. List with \`issues://\` to find the right filename, or create one with the \`issues\` tool.`,
		);
	}
	const content = await Bun.file(record.filePath).text();
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: record.filePath,
		notes: [
			`Issue #${record.id} (${record.category}${record.archived ? ", archived" : ""}).`,
			"This file is writable: use the `edit`/`write` tools for body changes; use the `issues` tool (`op: edit` / `archive` / `unarchive`) for metadata and lifecycle.",
		],
	};
}

async function writeIssueFile(cwd: string, url: InternalUrl, basename: string, content: string): Promise<WriteResult> {
	const record = await findIssueByFilename(cwd, basename);
	if (!record) {
		throw new Error(
			`Issue not found: ${basename}. List with \`issues://\` to find the right filename, or create one with the \`issues\` tool (\`op: add\`).`,
		);
	}

	// Validate that the new content still parses with frontmatter so the
	// model can't silently corrupt the metadata layer. The store relies on
	// `---` fences staying intact (titles, status, archive flag are all
	// derived from frontmatter, not the body).
	try {
		parseFrontmatter(content, { source: record.filePath, normalize: false, level: "fatal" });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`issues:// write rejected: content does not parse as YAML frontmatter (${detail}). Keep the \`---\` fences and YAML block intact when editing.`,
		);
	}

	let normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.endsWith("\n")) normalized += "\n";
	await Bun.write(record.filePath, normalized);
	return {
		text: `Wrote ${url.href} (${Buffer.byteLength(normalized, "utf-8")} bytes).`,
	};
}

/**
 * Protocol handler for project-local `issues://` URLs.
 *
 * Individual issue files are mutable so the `edit`/`write` tools can
 * change body and frontmatter directly. Listing URLs (`issues://`,
 * `issues://archive`) and per-resource `buildListing()` responses stamp
 * themselves immutable explicitly so the listing pages stay read-only
 * even though the handler default is mutable.
 */
export class IssuesProtocolHandler implements ProtocolHandler {
	readonly scheme = "issues";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const cwd = resolveIssuesCwd(context);
		const parsed = parseIssuesUrl(url);
		if (parsed.kind === "list") return buildListing(url, cwd, false);
		if (parsed.kind === "archive-list") return buildListing(url, cwd, true);
		if (parsed.kind === "file") {
			if (!parsed.basename) {
				throw new Error("issues:// file URL requires a basename (e.g. `issues://14-fix-egress.md`).");
			}
			return readIssueFile(url, cwd, parsed.basename);
		}
		throw new Error(`Unsupported issues:// shape: ${url.href}`);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<WriteResult> {
		const cwd = resolveIssuesCwd(context);
		const parsed = parseIssuesUrl(url);
		if (parsed.kind !== "file" || !parsed.basename) {
			throw new Error(
				"issues:// writes target a single issue file (e.g. `issues://14-fix-egress.md` or `issues://14.md`). Use the `issues` tool with `op: add` to create one, or `op: archive`/`unarchive`/`edit` for lifecycle and metadata.",
			);
		}
		return writeIssueFile(cwd, url, parsed.basename, content);
	}

	async complete(query: string): Promise<UrlCompletion[]> {
		const cwd = cwdFromRegistry();
		if (!cwd) return [];
		const lower = query.toLowerCase();
		const completions: UrlCompletion[] = [];

		if ("archive".startsWith(lower)) {
			completions.push({ value: "archive", description: "List archived issues" });
		}

		try {
			const summaries = await listIssues(cwd, { limit: 25 });
			for (const summary of summaries) {
				if (lower && !summary.filename.toLowerCase().startsWith(lower)) continue;
				completions.push({
					value: summary.filename,
					description: `#${summary.id} ${summary.title}`,
				});
			}
		} catch {
			// Issues root may not exist yet; just return the static entries.
		}
		return completions;
	}
}

// Re-export the issues root helper so the router and tools can resolve the
// disk location without importing from `../issues` directly when wiring up
// the protocol handler.
export { getIssuesRoot };
