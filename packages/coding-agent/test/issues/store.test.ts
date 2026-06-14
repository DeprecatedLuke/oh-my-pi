import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addIssue,
	archiveIssue,
	editIssue,
	findIssueByFilename,
	findIssueById,
	getIssuesRoot,
	listIssues,
	normalizeCategory,
	slugifyTitle,
	unarchiveIssue,
} from "@oh-my-pi/pi-coding-agent/issues";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-store-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("issues store: slug + category normalization", () => {
	it("slugifies titles into ≤5-word lowercase kebab", () => {
		expect(slugifyTitle("Replace allow-all phone egress with default-deny isolation")).toBe(
			"replace-allow-all-phone-egress",
		);
		expect(slugifyTitle("Fix: NULL pointer in alpha()")).toBe("fix-null-pointer-in-alpha");
		expect(slugifyTitle("    ")).toBe("untitled");
		expect(slugifyTitle("a")).toBe("a");
	});

	it("normalizes categories and rejects reserved/escape names", () => {
		expect(normalizeCategory("Security Stuff")).toBe("security-stuff");
		expect(normalizeCategory("Data Correctness!!")).toBe("data-correctness");
		expect(() => normalizeCategory("archive")).toThrow(/Invalid issue category/);
		expect(() => normalizeCategory("../leak")).toThrow(/Invalid issue category/);
		expect(() => normalizeCategory("")).toThrow(/Invalid issue category/);
	});
});

describe("issues store: lifecycle", () => {
	it("allocates global ids across categories", async () => {
		const first = await addIssue(tempDir, {
			category: "security",
			title: "First finding",
			body: "Body of the first finding.",
		});
		const second = await addIssue(tempDir, {
			category: "correctness",
			title: "Second finding",
			body: "Body of the second finding.",
		});
		const third = await addIssue(tempDir, {
			category: "security",
			title: "Third finding",
			body: "Body of the third finding.",
		});

		expect(first.record.id).toBe(1);
		expect(second.record.id).toBe(2);
		expect(third.record.id).toBe(3);
		expect(first.record.filename).toBe("1-first-finding.md");
		expect(second.record.filename).toBe("2-second-finding.md");
		expect(third.record.filename).toBe("3-third-finding.md");

		const onDisk = await fs.readFile(path.join(getIssuesRoot(tempDir), "security", "1-first-finding.md"), "utf-8");
		const { frontmatter } = parseFrontmatter(onDisk, { source: "test" });
		expect(frontmatter.title).toBe("First finding");
		expect(frontmatter.category).toBe("security");
		expect(frontmatter.status).toBe("open");
		expect(typeof frontmatter.created).toBe("string");
	});

	it("recovers id allocation after the counter file is deleted", async () => {
		await addIssue(tempDir, { category: "security", title: "First", body: "Body A." });
		await addIssue(tempDir, { category: "security", title: "Second", body: "Body B." });
		// Simulate a stale checkout that lost the counter.
		await fs.rm(path.join(getIssuesRoot(tempDir), ".next-id"), { force: true });

		const next = await addIssue(tempDir, {
			category: "security",
			title: "Third",
			body: "Body C.",
		});
		expect(next.record.id).toBe(3);
	});

	it("finds issues by id and by filename (id-only or full)", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Fix auth egress",
			body: "Detail.",
		});
		const byId = await findIssueById(tempDir, record.id);
		const byFullName = await findIssueByFilename(tempDir, record.filename);
		const byIdName = await findIssueByFilename(tempDir, `${record.id}.md`);
		const byBareId = await findIssueByFilename(tempDir, String(record.id));
		const missing = await findIssueByFilename(tempDir, "999.md");
		expect(byId?.id).toBe(record.id);
		expect(byFullName?.id).toBe(record.id);
		expect(byIdName?.id).toBe(record.id);
		expect(byBareId?.id).toBe(record.id);
		expect(missing).toBeUndefined();
	});

	it("edit renames file when title changes and moves it when category changes", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Old title",
			body: "Original body.",
		});
		const oldPath = record.filePath;

		const renamed = await editIssue(tempDir, {
			id: record.id,
			title: "New shorter title",
		});
		expect(renamed.renamed).toBe(true);
		expect(renamed.transitioned).toBe(false);
		expect(renamed.wasArchived).toBe(false);
		expect(renamed.record.filename).toBe(`${record.id}-new-shorter-title.md`);
		expect(await Bun.file(oldPath).exists()).toBe(false);
		// Body is preserved when the edit only touches metadata.
		expect(renamed.record.body).toBe("Original body.");

		const moved = await editIssue(tempDir, {
			id: record.id,
			category: "correctness",
		});
		expect(moved.moved).toBe(true);
		expect(moved.transitioned).toBe(false);
		expect(moved.record.category).toBe("correctness");
		expect(moved.record.filePath).toContain(`${path.sep}correctness${path.sep}`);
	});

	it("archive moves to archive/<cat> and unarchive restores it", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Privilege leak",
			body: "Body.",
		});
		const activePath = record.filePath;

		const archived = await archiveIssue(tempDir, record.id, { reason: "Fixed in #321" });
		expect(archived.wasArchived).toBe(false);
		expect(archived.record.archived).toBe(true);
		expect(archived.record.filePath).toContain(`${path.sep}archive${path.sep}security${path.sep}`);
		expect(archived.record.frontmatter.status).toBe("fixed");
		expect(archived.record.frontmatter.archive_reason).toBe("Fixed in #321");
		expect(await Bun.file(activePath).exists()).toBe(false);

		const restored = await unarchiveIssue(tempDir, record.id);
		expect(restored.wasActive).toBe(false);
		expect(restored.record.archived).toBe(false);
		expect(restored.record.frontmatter.status).toBe("open");
		expect(restored.record.frontmatter.archive_reason).toBeUndefined();
	});

	it("archive of an already-archived issue is a no-op", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "X",
			body: "B.",
		});
		await archiveIssue(tempDir, record.id);
		const second = await archiveIssue(tempDir, record.id);
		expect(second.wasArchived).toBe(true);
		expect(second.record.archived).toBe(true);
	});

	it("editIssue auto-archives when status moves to a terminal state and restores on reopen", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Privilege leak",
			body: "Body.",
		});
		const activePath = record.filePath;

		// `fixed` is a terminal status → auto-archive.
		const archived = await editIssue(tempDir, {
			id: record.id,
			status: "fixed",
		});
		expect(archived.transitioned).toBe(true);
		expect(archived.wasArchived).toBe(false);
		expect(archived.record.archived).toBe(true);
		expect(archived.record.frontmatter.status).toBe("fixed");
		expect(archived.record.filePath).toContain(`${path.sep}archive${path.sep}security${path.sep}`);
		expect(await Bun.file(activePath).exists()).toBe(false);

		// Editing an archived issue is now allowed; metadata-only edits stay archived.
		const metadataOnly = await editIssue(tempDir, {
			id: record.id,
			severity: "low",
		});
		expect(metadataOnly.transitioned).toBe(false);
		expect(metadataOnly.record.archived).toBe(true);
		expect(metadataOnly.record.frontmatter.severity).toBe("low");

		// `open` is a non-terminal status → auto-restore + drop archive_reason.
		const restored = await editIssue(tempDir, {
			id: record.id,
			status: "open",
		});
		expect(restored.transitioned).toBe(true);
		expect(restored.wasArchived).toBe(true);
		expect(restored.record.archived).toBe(false);
		expect(restored.record.frontmatter.status).toBe("open");
		expect(restored.record.frontmatter.archive_reason).toBeUndefined();
	});

	it("editIssue treats same-side status changes as in-place edits", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "WIP item",
			body: "Body.",
		});
		// open → in-progress is still on the active side; no transition.
		const same = await editIssue(tempDir, { id: record.id, status: "in-progress" });
		expect(same.transitioned).toBe(false);
		expect(same.record.archived).toBe(false);
		expect(same.record.frontmatter.status).toBe("in-progress");
	});
});

describe("issues store: listing + filtering", () => {
	it("lists active and archived issues with severity/status/query filters", async () => {
		const a = await addIssue(tempDir, {
			category: "security",
			title: "Sql injection in handler",
			body: "Allows attacker to read user table.",
			severity: "critical",
		});
		const b = await addIssue(tempDir, {
			category: "correctness",
			title: "Off-by-one in loop",
			body: "Last element missed when calling chunked iterator.",
			severity: "medium",
		});
		const c = await addIssue(tempDir, {
			category: "security",
			title: "Stack overflow risk",
			body: "Recursive parser may exhaust stack.",
			severity: "high",
		});
		await archiveIssue(tempDir, b.record.id, { reason: "Fixed" });

		const active = await listIssues(tempDir, { archived: false });
		expect(active.map(s => s.id).sort((x, y) => x - y)).toEqual([a.record.id, c.record.id]);

		const archived = await listIssues(tempDir, { archived: true });
		expect(archived.map(s => s.id)).toEqual([b.record.id]);

		const both = await listIssues(tempDir);
		expect(both.map(s => s.id).sort((x, y) => x - y)).toEqual([a.record.id, b.record.id, c.record.id]);

		const bySeverity = await listIssues(tempDir, { severity: "critical" });
		expect(bySeverity.map(s => s.id)).toEqual([a.record.id]);

		const byCategory = await listIssues(tempDir, { category: "security", archived: false });
		expect(byCategory.map(s => s.id).sort((x, y) => x - y)).toEqual([a.record.id, c.record.id]);

		const byQuery = await listIssues(tempDir, { query: "recursive parser" });
		expect(byQuery.map(s => s.id)).toEqual([c.record.id]);

		const limited = await listIssues(tempDir, { limit: 1 });
		expect(limited.length).toBe(1);
		// Newest id first.
		expect(limited[0].id).toBe(c.record.id);
	});
});

describe("issues store: empty category directory pruning", () => {
	async function dirExists(dir: string): Promise<boolean> {
		try {
			const stat = await fs.stat(dir);
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	it("removes the active category dir when its last issue is archived, keeping siblings", async () => {
		const root = getIssuesRoot(tempDir);
		const security = await addIssue(tempDir, { category: "security", title: "Lone", body: "B." });
		const correctnessA = await addIssue(tempDir, { category: "correctness", title: "Keep A", body: "B." });
		await addIssue(tempDir, { category: "correctness", title: "Keep B", body: "B." });

		await archiveIssue(tempDir, security.record.id);
		// security had a single issue → its active dir is gone.
		expect(await dirExists(path.join(root, "security"))).toBe(false);
		// correctness still holds an issue → untouched.
		expect(await dirExists(path.join(root, "correctness"))).toBe(true);

		// Archiving one of two issues in a category must NOT prune it.
		await archiveIssue(tempDir, correctnessA.record.id);
		expect(await dirExists(path.join(root, "correctness"))).toBe(true);
		// The issues root itself is never pruned (anchors the counter + archive).
		expect(await dirExists(root)).toBe(true);
	});

	it("removes the source category dir on a cross-category move", async () => {
		const root = getIssuesRoot(tempDir);
		const { record } = await addIssue(tempDir, { category: "security", title: "Movable", body: "B." });
		expect(await dirExists(path.join(root, "security"))).toBe(true);

		await editIssue(tempDir, { id: record.id, category: "correctness" });
		expect(await dirExists(path.join(root, "security"))).toBe(false);
		expect(await dirExists(path.join(root, "correctness"))).toBe(true);
	});

	it("keeps the category dir on a same-category slug rename", async () => {
		const root = getIssuesRoot(tempDir);
		const { record } = await addIssue(tempDir, { category: "security", title: "Old name", body: "B." });

		await editIssue(tempDir, { id: record.id, title: "New name entirely" });
		// The renamed file still lives in security/ → dir must survive (the new
		// file landed before the old one was removed, so rmdir hits ENOTEMPTY).
		expect(await dirExists(path.join(root, "security"))).toBe(true);
	});

	it("removes the archived category dir and the archive root when the last archived issue is unarchived", async () => {
		const archiveRoot = path.join(getIssuesRoot(tempDir), "archive");
		const { record } = await addIssue(tempDir, { category: "security", title: "Round trip", body: "B." });
		await archiveIssue(tempDir, record.id);
		expect(await dirExists(path.join(archiveRoot, "security"))).toBe(true);

		await unarchiveIssue(tempDir, record.id);
		// Archived category emptied → pruned; archive root now empty → also pruned.
		expect(await dirExists(path.join(archiveRoot, "security"))).toBe(false);
		expect(await dirExists(archiveRoot)).toBe(false);
	});

	it("keeps the archive root when another archived category remains", async () => {
		const archiveRoot = path.join(getIssuesRoot(tempDir), "archive");
		const a = await addIssue(tempDir, { category: "security", title: "A", body: "B." });
		const b = await addIssue(tempDir, { category: "correctness", title: "B", body: "B." });
		await archiveIssue(tempDir, a.record.id);
		await archiveIssue(tempDir, b.record.id);

		await unarchiveIssue(tempDir, a.record.id);
		// security archive dir emptied → pruned, but correctness archive remains,
		// so the archive root must survive.
		expect(await dirExists(path.join(archiveRoot, "security"))).toBe(false);
		expect(await dirExists(path.join(archiveRoot, "correctness"))).toBe(true);
		expect(await dirExists(archiveRoot)).toBe(true);
	});
});
