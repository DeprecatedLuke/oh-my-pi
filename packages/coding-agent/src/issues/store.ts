/**
 * Project-local issue tracker storage.
 *
 * Layout under `<cwd>/.omp/issues`:
 *   <category>/<id>-<slug>.md       active issues
 *   .archive/<category>/<id>-<slug>.md archived issues
 *   .next-id                        single-line decimal counter
 *
 * The id is **global**: one counter across every category and across
 * active + archive, so each issue has a stable handle regardless of where
 * its file currently lives. The counter file is a hint — every write
 * re-scans active + archive on collision so two racing sessions can never
 * produce two files with the same id.
 *
 * Filenames carry the id as a left-anchored prefix (`<id>-<slug>.md`) and
 * are looked up by id alone via {@link findIssueById}; the slug part is
 * for human readability in `ls` and the URL handler accepts either form.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isEnotempty, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Severity bucket; matches the echophone ISSUES.md convention. */
export type IssueSeverity = "low" | "medium" | "high" | "critical";

/** Lifecycle status. The file's location (active vs archive) is the source
 *  of truth; `status` is metadata that the agent and renderers can read. */
export type IssueStatus = "open" | "in-progress" | "fixed" | "wontfix" | "duplicate";

export interface IssueFrontmatter {
	title: string;
	category?: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	location?: string[];
	created?: string;
	updated?: string;
	[key: string]: unknown;
}

export interface IssueRecord {
	id: number;
	category: string;
	slug: string;
	filename: string;
	/** Absolute filesystem path. */
	filePath: string;
	/** Relative path from `<root>` (e.g. `security/14-foo.md`). */
	relativePath: string;
	archived: boolean;
	frontmatter: IssueFrontmatter;
	body: string;
}

export interface IssueSummary {
	id: number;
	category: string;
	title: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	archived: boolean;
	updated?: string;
	created?: string;
	filename: string;
}

export interface AddIssueInput {
	category: string;
	title: string;
	body: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	location?: string[];
	/** Extra frontmatter fields to merge in (e.g. `confidence`, `file_path`). */
	extra?: Record<string, unknown>;
}

export interface ListIssuesOptions {
	category?: string;
	archived?: boolean;
	severity?: IssueSeverity;
	status?: IssueStatus;
	/** Plain-text query; case-insensitive substring match against title + body + frontmatter values. */
	query?: string;
	/** Hard limit on returned records (post-sort). */
	limit?: number;
}

const ISSUES_DIR = path.join(".omp", "issues");
const ARCHIVE_SEGMENT = ".archive";
const LEGACY_ARCHIVE_SEGMENT = "archive";
const COUNTER_FILE = ".next-id";
const RESERVED_SEGMENTS = new Set([ARCHIVE_SEGMENT, LEGACY_ARCHIVE_SEGMENT, ".", "..", ""]);

const SLUG_MAX_WORDS = 5;
const SLUG_MAX_CHARS = 50;
const ID_FILENAME_RE = /^(\d+)-(.*)\.md$/;

export function getIssuesRoot(cwd: string): string {
	return path.join(cwd, ISSUES_DIR);
}

function getArchiveRoot(cwd: string): string {
	return path.join(getIssuesRoot(cwd), ARCHIVE_SEGMENT);
}

function getCounterPath(cwd: string): string {
	return path.join(getIssuesRoot(cwd), COUNTER_FILE);
}

/**
 * Normalize an arbitrary category string into a safe directory name. Throws
 * on segments that would alias the archive bucket or escape the issues root.
 */
export function normalizeCategory(input: string): string {
	const trimmed = input.trim();
	if (!trimmed || /[\\/]|\.\.|^\.$/.test(trimmed)) {
		throw new Error(`Invalid issue category: ${JSON.stringify(input)}`);
	}
	const normalized = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!normalized || normalized.startsWith(".") || RESERVED_SEGMENTS.has(normalized)) {
		throw new Error(`Invalid issue category: ${JSON.stringify(input)}`);
	}
	return normalized;
}

/**
 * Convert a human title into a filesystem slug:
 * lowercase, alphanumerics joined with `-`, first {@link SLUG_MAX_WORDS}
 * words, capped at {@link SLUG_MAX_CHARS} chars. Empty input yields
 * `"untitled"` so we never produce `<id>-.md`.
 */
export function slugifyTitle(title: string): string {
	const words = title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]+/g, " ")
		.split(/[\s-]+/)
		.filter(Boolean)
		.slice(0, SLUG_MAX_WORDS);
	const joined = words.join("-").slice(0, SLUG_MAX_CHARS).replace(/-+$/g, "");
	return joined || "untitled";
}

function parseIdFromFilename(filename: string): number | undefined {
	const match = filename.match(ID_FILENAME_RE);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseSlugFromFilename(filename: string): string {
	const match = filename.match(ID_FILENAME_RE);
	return match?.[2] ?? "";
}

async function listSubdirs(root: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

/**
 * Migrate a legacy `archive/` directory to the hidden `.archive/` layout. Runs
 * before every scan so all reads/writes see the canonical archive root. Only
 * renames when the legacy dir exists and `.archive/` does not, so a
 * partially-migrated or hand-edited store is never clobbered (a leftover legacy
 * dir is also filtered out of active categories as a safeguard).
 */
async function migrateLegacyArchive(cwd: string): Promise<void> {
	const legacyRoot = path.join(getIssuesRoot(cwd), LEGACY_ARCHIVE_SEGMENT);
	const archiveRoot = getArchiveRoot(cwd);
	try {
		if (!(await fs.stat(legacyRoot)).isDirectory()) return;
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	try {
		await fs.stat(archiveRoot);
		return; // `.archive/` already present — leave the legacy dir untouched.
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	await fs.rename(legacyRoot, archiveRoot);
}

interface FilesystemScan {
	/** All issue records found, regardless of archive state. */
	records: Array<{ id: number; filePath: string; filename: string; category: string; archived: boolean }>;
	/** Max id across active + archive (0 when no issues exist). */
	maxId: number;
}

async function scanFilesystem(cwd: string): Promise<FilesystemScan> {
	await migrateLegacyArchive(cwd);
	const issuesRoot = getIssuesRoot(cwd);
	const archiveRoot = getArchiveRoot(cwd);
	const records: FilesystemScan["records"] = [];
	let maxId = 0;

	const activeCategories = (await listSubdirs(issuesRoot)).filter(
		name => name !== ARCHIVE_SEGMENT && name !== LEGACY_ARCHIVE_SEGMENT,
	);
	for (const category of activeCategories) {
		const dir = path.join(issuesRoot, category);
		const files = await listMarkdownFiles(dir);
		for (const filename of files) {
			const id = parseIdFromFilename(filename);
			if (id === undefined) continue;
			records.push({ id, filePath: path.join(dir, filename), filename, category, archived: false });
			if (id > maxId) maxId = id;
		}
	}

	const archiveCategories = await listSubdirs(archiveRoot);
	for (const category of archiveCategories) {
		const dir = path.join(archiveRoot, category);
		const files = await listMarkdownFiles(dir);
		for (const filename of files) {
			const id = parseIdFromFilename(filename);
			if (id === undefined) continue;
			records.push({ id, filePath: path.join(dir, filename), filename, category, archived: true });
			if (id > maxId) maxId = id;
		}
	}

	return { records, maxId };
}

async function readCounter(cwd: string): Promise<number | undefined> {
	try {
		const text = (await Bun.file(getCounterPath(cwd)).text()).trim();
		if (!text) return undefined;
		const value = Number(text);
		return Number.isFinite(value) && value > 0 ? value : undefined;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

async function writeCounter(cwd: string, next: number): Promise<void> {
	await Bun.write(getCounterPath(cwd), `${next}\n`);
}

/**
 * Reserve the next global id. Uses the counter file as a hint and falls back
 * to a full scan if the counter is missing, stale, or contended. Returns the
 * id we own — the caller must immediately use it to create a file.
 */
async function allocateId(cwd: string): Promise<number> {
	const counter = await readCounter(cwd);
	const scan = await scanFilesystem(cwd);
	// Pick max(counter, scan.maxId + 1) so we never reuse an id even if the
	// counter was deleted by a stale checkout.
	const candidate = Math.max(counter ?? 1, scan.maxId + 1);
	// Sanity check: candidate must not collide with any existing record.
	let id = candidate;
	const used = new Set(scan.records.map(r => r.id));
	while (used.has(id)) id += 1;
	return id;
}

function buildFilename(id: number, slug: string): string {
	return `${id}-${slug}.md`;
}

const YAML_NEEDS_QUOTE = /[:#&*!|>'"%@`{}[\]]|^[-?]|^\s|\s$|^$/;
function yamlScalar(value: string): string {
	if (!YAML_NEEDS_QUOTE.test(value) && !/[\n]/.test(value)) return value;
	// Single-quote with internal `'` doubled — covers every printable ASCII +
	// Unicode case we ever put in frontmatter (titles, paths, statuses).
	return `'${value.replace(/'/g, "''")}'`;
}

function yamlValueLine(key: string, value: unknown): string[] {
	if (value === null || value === undefined) return [`${key}: null`];
	if (typeof value === "boolean" || typeof value === "number") return [`${key}: ${value}`];
	if (typeof value === "string") return [`${key}: ${yamlScalar(value)}`];
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${key}: []`];
		const items = value
			.filter((item): item is string => typeof item === "string")
			.map(item => `  - ${yamlScalar(item)}`);
		return [`${key}:`, ...items];
	}
	// Fallback for unexpected object values — JSON-encode on a single line.
	return [`${key}: ${YAML.stringify(value).trim()}`];
}

function formatFrontmatter(frontmatter: IssueFrontmatter): string {
	const preferred = ["title", "category", "severity", "status", "created", "updated", "location"];
	const lines: string[] = [];
	for (const key of preferred) {
		if (frontmatter[key] !== undefined) lines.push(...yamlValueLine(key, frontmatter[key]));
	}
	for (const [key, value] of Object.entries(frontmatter)) {
		if (preferred.includes(key)) continue;
		if (value !== undefined) lines.push(...yamlValueLine(key, value));
	}
	return `---\n${lines.join("\n")}\n---\n`;
}

function serializeIssue(frontmatter: IssueFrontmatter, body: string): string {
	const trimmedBody = body.replace(/^\s+/, "").replace(/\s+$/, "");
	if (!trimmedBody) {
		return formatFrontmatter(frontmatter);
	}
	return `${formatFrontmatter(frontmatter)}\n${trimmedBody}\n`;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map(item => (typeof item === "string" ? item.trim() : "")).filter(item => item.length > 0);
	return out.length > 0 ? out : undefined;
}

function coerceFrontmatter(raw: Record<string, unknown>): IssueFrontmatter {
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	const out: IssueFrontmatter = { title: title || "(untitled)" };
	if (typeof raw.category === "string") out.category = raw.category;
	if (typeof raw.severity === "string") out.severity = raw.severity as IssueSeverity;
	if (typeof raw.status === "string") out.status = raw.status as IssueStatus;
	if (typeof raw.created === "string") out.created = raw.created;
	if (typeof raw.updated === "string") out.updated = raw.updated;
	const location = asStringArray(raw.location);
	if (location) out.location = location;
	for (const [key, value] of Object.entries(raw)) {
		if (key in out) continue;
		out[key] = value;
	}
	return out;
}

async function readIssueFromPath(
	filePath: string,
	id: number,
	category: string,
	archived: boolean,
): Promise<IssueRecord> {
	const filename = path.basename(filePath);
	const content = await Bun.file(filePath).text();
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath, normalize: false });
	const slug = parseSlugFromFilename(filename);
	return {
		id,
		category,
		slug,
		filename,
		filePath,
		relativePath: archived ? path.join(ARCHIVE_SEGMENT, category, filename) : path.join(category, filename),
		archived,
		frontmatter: coerceFrontmatter(frontmatter),
		body,
	};
}

/** Find an issue by global id, looking in active and then archive. */
export async function findIssueById(cwd: string, id: number): Promise<IssueRecord | undefined> {
	const scan = await scanFilesystem(cwd);
	const match = scan.records.find(r => r.id === id);
	if (!match) return undefined;
	return readIssueFromPath(match.filePath, match.id, match.category, match.archived);
}

/**
 * Find an issue by basename. Accepts:
 * - `<id>-<slug>.md` (exact file)
 * - `<id>.md` (id-only convenience)
 * - `<id>` (no extension)
 * - `<id>-<slug>` (no extension)
 */
export async function findIssueByFilename(cwd: string, basename: string): Promise<IssueRecord | undefined> {
	const cleaned = basename.replace(/\.md$/i, "");
	const match = cleaned.match(/^(\d+)(?:-(.*))?$/);
	if (!match) return undefined;
	const id = Number(match[1]);
	if (!Number.isFinite(id) || id <= 0) return undefined;
	return findIssueById(cwd, id);
}

function recordToSummary(record: IssueRecord): IssueSummary {
	return {
		id: record.id,
		category: record.category,
		title: record.frontmatter.title,
		severity: record.frontmatter.severity,
		status: record.frontmatter.status,
		archived: record.archived,
		updated: record.frontmatter.updated,
		created: record.frontmatter.created,
		filename: record.filename,
	};
}

/**
 * List issues, optionally filtered. Active issues are returned by default;
 * pass `archived: true` for archived only, or omit the filter to get both.
 */
export async function listIssues(cwd: string, options: ListIssuesOptions = {}): Promise<IssueSummary[]> {
	const scan = await scanFilesystem(cwd);
	const records: IssueRecord[] = [];
	for (const entry of scan.records) {
		if (options.archived !== undefined && entry.archived !== options.archived) continue;
		if (options.category && entry.category !== normalizeCategory(options.category)) continue;
		records.push(await readIssueFromPath(entry.filePath, entry.id, entry.category, entry.archived));
	}

	const query = options.query?.trim().toLowerCase();
	const filtered = records.filter(record => {
		if (options.severity && record.frontmatter.severity !== options.severity) return false;
		if (options.status && record.frontmatter.status !== options.status) return false;
		if (!query) return true;
		if (record.frontmatter.title.toLowerCase().includes(query)) return true;
		if (record.body.toLowerCase().includes(query)) return true;
		for (const value of Object.values(record.frontmatter)) {
			if (typeof value === "string" && value.toLowerCase().includes(query)) return true;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === "string" && item.toLowerCase().includes(query)) return true;
				}
			}
		}
		return false;
	});

	// Newest first by id (proxy for creation order).
	filtered.sort((a, b) => b.id - a.id);
	const summaries = filtered.map(recordToSummary);
	if (options.limit !== undefined && options.limit > 0) {
		return summaries.slice(0, options.limit);
	}
	return summaries;
}

function nowIso(): string {
	return new Date().toISOString();
}

export interface AddIssueResult {
	record: IssueRecord;
	created: true;
}

export async function addIssue(cwd: string, input: AddIssueInput): Promise<AddIssueResult> {
	const category = normalizeCategory(input.category);
	const title = input.title.trim();
	if (!title) {
		throw new Error("Issue title is required.");
	}
	const body = input.body.replace(/\r\n?/g, "\n").trim();
	if (!body) {
		throw new Error("Issue body is required.");
	}

	const slug = slugifyTitle(title);
	const id = await allocateId(cwd);
	const filename = buildFilename(id, slug);
	const dir = path.join(getIssuesRoot(cwd), category);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, filename);

	const created = nowIso();
	const frontmatter: IssueFrontmatter = {
		title,
		category,
		severity: input.severity,
		status: input.status ?? "open",
		created,
		updated: created,
		location: input.location && input.location.length > 0 ? input.location : undefined,
		...input.extra,
	};

	const content = serializeIssue(frontmatter, body);
	// `wx` ensures we never silently clobber an existing file if a racing
	// session got the same id between scan and write; on EEXIST we re-allocate.
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(filePath, "wx");
		await handle.writeFile(content);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			// Retry exactly once with a fresh allocation; the scan-then-write
			// loop in allocateId already deduplicates against the conflict.
			return addIssue(cwd, input);
		}
		throw err;
	} finally {
		await handle?.close();
	}

	await writeCounter(cwd, id + 1).catch(() => {
		// Counter is a hint — failing to update it is not fatal; the next
		// allocation will fall back to a scan.
	});

	const record = await readIssueFromPath(filePath, id, category, false);
	return { record, created: true };
}

export interface EditIssueResult {
	record: IssueRecord;
	/** `true` when the issue moved to a different category. */
	moved: boolean;
	/** `true` when the on-disk filename slug changed. */
	renamed: boolean;
	/** `true` when the edit toggled the active/archive side via status. */
	transitioned: boolean;
	/** Archive side before the edit. Useful to render "→ archived"/"→ active". */
	wasArchived: boolean;
}

/**
 * Statuses that keep an issue on the active side. Anything else — `fixed`,
 * `wontfix`, `duplicate`, or any future non-active status — belongs in the
 * archive, so a status edit that leaves this set auto-moves the file. Mirrors
 * the defaults used by {@link archiveIssue} (status: fixed) and
 * {@link unarchiveIssue} (status: open).
 */
const ACTIVE_STATUSES: ReadonlySet<IssueStatus> = new Set(["open", "in-progress"]);

/** Statuses accepted in issue frontmatter (the metadata-edit validation set). */
const ISSUE_STATUSES: ReadonlySet<string> = new Set<IssueStatus>([
	"open",
	"in-progress",
	"fixed",
	"wontfix",
	"duplicate",
]);
/** Severities accepted in issue frontmatter (the metadata-edit validation set). */
const ISSUE_SEVERITIES: ReadonlySet<string> = new Set<IssueSeverity>(["low", "medium", "high", "critical"]);

function shouldBeArchived(status: IssueStatus | undefined, currentArchived: boolean): boolean {
	if (!status) return currentArchived;
	return !ACTIVE_STATUSES.has(status);
}

/**
 * Remove a now-empty category directory after its last issue moved out. The
 * issues/archive roots themselves are preserved (they anchor the tracker and
 * hold the counter file); only per-category subdirectories are pruned, plus the
 * archive root once its last category is gone. `rmdir` (non-recursive) only
 * succeeds on an empty dir, so a category that still holds issues — or a same-dir
 * slug rename, where the new file already landed — fails atomically with
 * ENOTEMPTY and is left intact. Best-effort: a failure to prune never fails the
 * move that already succeeded.
 */
async function pruneEmptyCategoryDir(cwd: string, categoryDir: string): Promise<void> {
	const issuesRoot = getIssuesRoot(cwd);
	const archiveRoot = getArchiveRoot(cwd);
	// Never prune the roots via the category path (the archive root is handled
	// as a follow-up below); only a true per-category subdirectory is eligible.
	if (categoryDir === issuesRoot || categoryDir === archiveRoot) return;
	try {
		await fs.rmdir(categoryDir);
	} catch (err) {
		if (isEnotempty(err) || isEnoent(err)) return;
		throw err;
	}
	// An archived category sits under the archive root; once the last category
	// is pruned the archive root is empty too, so retire it (it is recreated on
	// demand by the next archive). The issues root is never pruned.
	if (path.dirname(categoryDir) === archiveRoot) {
		try {
			await fs.rmdir(archiveRoot);
		} catch (err) {
			if (isEnotempty(err) || isEnoent(err)) return;
			throw err;
		}
	}
}

/**
 * Parse and validate an edited issue file (frontmatter + body). The frontmatter
 * is the metadata layer the store derives title/status/category from, so a write
 * that drops the `---` fences, ships unparseable YAML, or carries an out-of-enum
 * `status`/`severity` is rejected before it can corrupt the record. Throws a
 * descriptive `Error` naming the failure.
 */
function parseIssueFileContent(content: string, source: string): { frontmatter: IssueFrontmatter; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---") || normalized.indexOf("\n---", 3) === -1) {
		throw new Error(
			"issues:// write rejected: the file must open with a `---` YAML frontmatter block and close it with a `---` line — title/status/severity live there. Keep both fences intact when editing.",
		);
	}
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(normalized, { source, normalize: false, level: "fatal" });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`issues:// write rejected: the frontmatter does not parse as YAML (${detail}). Keep the \`---\` fences and YAML block intact when editing.`,
		);
	}
	const frontmatter = coerceFrontmatter(parsed.frontmatter);
	const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title.trim() : "";
	if (!title) {
		throw new Error("issues:// write rejected: the frontmatter `title` is required and must be a non-empty string.");
	}
	if (frontmatter.status !== undefined && !ISSUE_STATUSES.has(frontmatter.status)) {
		throw new Error(
			`issues:// write rejected: invalid status '${frontmatter.status}'. Use one of: open, in-progress, fixed, wontfix, duplicate.`,
		);
	}
	if (frontmatter.severity !== undefined && !ISSUE_SEVERITIES.has(frontmatter.severity)) {
		throw new Error(
			`issues:// write rejected: invalid severity '${frontmatter.severity}'. Use one of: low, medium, high, critical.`,
		);
	}
	frontmatter.title = title;
	return { frontmatter, body: parsed.body };
}

/**
 * Persist a full edited issue file by id. This is the single metadata-edit
 * surface: the `issues://<id>.md` write path routes here, so editing the
 * frontmatter drives the same lifecycle a structured edit once did — a terminal
 * `status` archives the file, a `category` change moves it, a `title` change
 * re-derives the slug — while the body is replaced from the same write. The
 * file is authoritative for metadata; `created`/`updated` are managed here, not
 * taken from the edited text.
 */
export async function saveIssueContent(cwd: string, id: number, content: string): Promise<EditIssueResult> {
	const current = await findIssueById(cwd, id);
	if (!current) {
		throw new Error(`Issue #${id} not found.`);
	}

	const { frontmatter: edited, body } = parseIssueFileContent(content, current.filePath);

	const nextTitle = edited.title;
	const nextCategory = edited.category ? normalizeCategory(edited.category) : current.category;
	const nextStatus = edited.status ?? current.frontmatter.status;
	const nextArchived = shouldBeArchived(nextStatus, current.archived);

	const frontmatter: IssueFrontmatter = {
		...edited,
		title: nextTitle,
		category: nextCategory,
		status: nextStatus,
		created: current.frontmatter.created ?? edited.created,
		updated: nowIso(),
	};
	// `archive_reason` only makes sense while archived; drop it on the way back
	// to active so the metadata layer stays consistent with `unarchiveIssue`.
	if (!nextArchived) {
		delete frontmatter.archive_reason;
	}

	const nextSlug = slugifyTitle(nextTitle);
	const nextFilename = buildFilename(current.id, nextSlug);
	const nextRoot = nextArchived
		? path.join(getArchiveRoot(cwd), nextCategory)
		: path.join(getIssuesRoot(cwd), nextCategory);
	const nextPath = path.join(nextRoot, nextFilename);

	const moved = nextCategory !== current.category;
	const renamed = nextFilename !== current.filename;
	const transitioned = nextArchived !== current.archived;

	await fs.mkdir(nextRoot, { recursive: true });
	const serialized = serializeIssue(frontmatter, body);

	if (nextPath !== current.filePath) {
		await Bun.write(nextPath, serialized);
		await fs.rm(current.filePath, { force: true });
		// A cross-category/archive move can leave the source category empty.
		await pruneEmptyCategoryDir(cwd, path.dirname(current.filePath));
	} else {
		await Bun.write(current.filePath, serialized);
	}

	const record = await readIssueFromPath(nextPath, current.id, nextCategory, nextArchived);
	return { record, moved, renamed, transitioned, wasArchived: current.archived };
}

export interface ArchiveResult {
	record: IssueRecord;
	wasArchived: boolean;
}

/** Move an active issue to the archive (no-op if already archived). */
export async function archiveIssue(
	cwd: string,
	id: number,
	options: { reason?: string; status?: IssueStatus } = {},
): Promise<ArchiveResult> {
	const current = await findIssueById(cwd, id);
	if (!current) throw new Error(`Issue #${id} not found.`);
	if (current.archived) {
		return { record: current, wasArchived: true };
	}

	const frontmatter: IssueFrontmatter = {
		...current.frontmatter,
		status: options.status ?? "fixed",
		updated: nowIso(),
	};
	if (options.reason !== undefined && options.reason.trim().length > 0) {
		frontmatter.archive_reason = options.reason.trim();
	}

	const targetDir = path.join(getArchiveRoot(cwd), current.category);
	await fs.mkdir(targetDir, { recursive: true });
	const targetPath = path.join(targetDir, current.filename);
	const content = serializeIssue(frontmatter, current.body);
	await Bun.write(targetPath, content);
	await fs.rm(current.filePath, { force: true });
	// Archiving the last active issue in a category empties its dir.
	await pruneEmptyCategoryDir(cwd, path.dirname(current.filePath));

	const record = await readIssueFromPath(targetPath, current.id, current.category, true);
	return { record, wasArchived: false };
}

export interface UnarchiveResult {
	record: IssueRecord;
	wasActive: boolean;
}

/** Move an archived issue back to active. */
export async function unarchiveIssue(
	cwd: string,
	id: number,
	options: { status?: IssueStatus } = {},
): Promise<UnarchiveResult> {
	const current = await findIssueById(cwd, id);
	if (!current) throw new Error(`Issue #${id} not found.`);
	if (!current.archived) {
		return { record: current, wasActive: true };
	}

	const frontmatter: IssueFrontmatter = {
		...current.frontmatter,
		status: options.status ?? "open",
		updated: nowIso(),
	};
	delete frontmatter.archive_reason;

	const targetDir = path.join(getIssuesRoot(cwd), current.category);
	await fs.mkdir(targetDir, { recursive: true });
	const targetPath = path.join(targetDir, current.filename);
	const content = serializeIssue(frontmatter, current.body);
	await Bun.write(targetPath, content);
	await fs.rm(current.filePath, { force: true });
	// Unarchiving the last issue in an archived category empties its dir (and
	// possibly the archive root, which `pruneEmptyCategoryDir` handles).
	await pruneEmptyCategoryDir(cwd, path.dirname(current.filePath));

	const record = await readIssueFromPath(targetPath, current.id, current.category, false);
	return { record, wasActive: false };
}

/**
 * Render a markdown listing of issues. Used by both the URL handler and the
 * tool so the listing format is identical regardless of entry point.
 */
export function renderIssueListing(
	summaries: IssueSummary[],
	options: { title: string; emptyText: string; group?: boolean; showArchived?: boolean } = {
		title: "# Issues",
		emptyText: "_No issues._",
	},
): string {
	const lines: string[] = [options.title, ""];
	if (summaries.length === 0) {
		lines.push(options.emptyText);
		return lines.join("\n");
	}

	if (options.group) {
		const grouped = new Map<string, IssueSummary[]>();
		for (const summary of summaries) {
			const key = options.showArchived
				? `${summary.archived ? "archive/" : ""}${summary.category}`
				: summary.category;
			const bucket = grouped.get(key);
			if (bucket) bucket.push(summary);
			else grouped.set(key, [summary]);
		}
		for (const [category, items] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`## ${category} (${items.length})`);
			lines.push("");
			for (const summary of items) {
				lines.push(formatSummaryLine(summary));
			}
			lines.push("");
		}
	} else {
		for (const summary of summaries) {
			lines.push(formatSummaryLine(summary));
		}
	}

	return lines.join("\n").trimEnd();
}

function formatSummaryLine(summary: IssueSummary): string {
	const flags: string[] = [];
	if (summary.severity) flags.push(summary.severity);
	if (summary.status && summary.status !== "open") flags.push(summary.status);
	const tag = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	const archivedSuffix = summary.archived ? " (archived)" : "";
	return `- \`issues://${summary.filename}\` #${summary.id} · ${summary.title}${tag}${archivedSuffix}`;
}
