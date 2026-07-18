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
 * Individual issue files are edited by rewriting them with the `write` tool on
 * the `issues://<id>.md` URL — the single metadata-and-body edit surface. Writing
 * the frontmatter drives the lifecycle: a terminal `status` archives the file, a
 * `category` change moves it, a `title` change re-derives the slug. The write is
 * validated (intact `---` fences, parseable YAML, in-enum status/severity) and
 * rejected on failure. The `issues` tool keeps only id-allocating/shortcut ops
 * (`add`, `archive`, `unarchive`, `list`); raw writes to listing URLs
 * (`issues://`, `issues://archive`) are rejected.
 */
import { findIssueByFilename, getIssuesRoot, listIssues, renderIssueListing, saveIssueContent } from "../issues";
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

function resolveIssuesCwd(context?: { cwd?: string }): string {
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
		? "\n\nUse `issues://` for active issues. Edit an issue (body or metadata) by rewriting `issues://<id>.md` with the `write` tool — frontmatter changes drive status/category/slug lifecycle."
		: "\n\nUse `issues://archive` for archived issues. Edit an issue (body or metadata) by rewriting `issues://<id>.md` with the `write` tool — frontmatter changes drive status/category/slug lifecycle.";
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
			"This file is writable: edit it by rewriting the `issues://<id>.md` URL with the `write` tool (use the URL, not the on-disk path shown above) so frontmatter edits are validated and drive lifecycle — a terminal `status` archives, a `category` change moves, a `title` change renames; a malformed edit is rejected.",
		],
	};
}

async function writeIssueFile(cwd: string, basename: string, content: string): Promise<WriteResult> {
	const record = await findIssueByFilename(cwd, basename);
	if (!record) {
		throw new Error(
			`Issue not found: ${basename}. List with \`issues://\` to find the right filename, or create one with the \`issues\` tool (\`op: add\`).`,
		);
	}

	// The store validates the edited content (intact `---` fences, parseable
	// YAML, in-enum status/severity) and applies whatever lifecycle the new
	// frontmatter implies — terminal status archives, category change moves,
	// title change renames. A malformed edit throws here and is rejected before
	// it can corrupt the metadata layer.
	const { record: saved, moved, renamed, transitioned } = await saveIssueContent(cwd, record.id, content);
	const notes: string[] = [];
	if (transitioned) {
		notes.push(saved.archived ? "moved → archive (status closed)" : "restored → active (status reopened)");
	}
	if (moved) notes.push(`moved → category ${saved.category}`);
	if (renamed) notes.push(`renamed → ${saved.filename}`);
	const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
	return {
		text: `Updated issue #${saved.id}${suffix}. Now at issues://${saved.filename}${saved.archived ? " (archived)" : ""}.`,
	};
}

/**
 * Protocol handler for project-local `issues://` URLs.
 *
 * Individual issue files are mutable so the `write` tool can rewrite body and
 * frontmatter via the `issues://<id>.md` URL (frontmatter edits drive lifecycle,
 * validated in the store). Listing URLs (`issues://`,
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
				"issues:// writes target a single issue file (e.g. `issues://14-fix-egress.md` or `issues://14.md`). Use the `issues` tool with `op: add` to create one, or edit an existing issue (body or metadata) by rewriting `issues://<id>.md` with the `write` tool.",
			);
		}
		return writeIssueFile(cwd, parsed.basename, content);
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
