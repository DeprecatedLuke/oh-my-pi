/**
 * `issues` tool integration tests. Drives the tool's `execute` API directly
 * against a temp working directory and asserts the on-disk state plus the
 * structured details that reach the parent task render path.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findIssueById, getIssuesRoot } from "@oh-my-pi/pi-coding-agent/issues";
import { IssuesTool, type IssuesToolDetails } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolSession } from "../../src/tools";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-tool-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

function makeTool(cwd: string): IssuesTool {
	const session = createSession(cwd);
	const tool = IssuesTool.createIf(session);
	if (!tool) throw new Error("issues tool should be available with default settings");
	return tool;
}

describe("IssuesTool", () => {
	it("add creates a file under .omp/issues/<category>/ and returns rendering details", async () => {
		const tool = makeTool(tempDir);
		const result = await tool.execute("tc-1", {
			op: "add",
			category: "security",
			title: "Reset password leak",
			body: "Description of the bug.\n\n## Fix\n1. Validate.",
			severity: "high",
			location: ["src/auth/reset.ts:10-20"],
			extra: { confidence: 0.85 },
		});

		const details = result.details as IssuesToolDetails;
		expect(details.op).toBe("add");
		expect(details.id).toBe(1);
		expect(details.category).toBe("security");
		expect(details.severity).toBe("high");
		expect(details.url).toBe(`issues://${details.filename}`);
		expect(details.bodyPreview).toContain("Description of the bug");
		expect(details.location).toBe("src/auth/reset.ts:10-20");
		expect(details.confidence).toBe(0.85);

		const filePath = path.join(getIssuesRoot(tempDir), "security", details.filename!);
		expect(await Bun.file(filePath).exists()).toBe(true);
	});

	it("edit changes metadata and re-derives slug; archive then unarchive moves the file", async () => {
		const tool = makeTool(tempDir);
		const created = await tool.execute("tc-1", {
			op: "add",
			category: "security",
			title: "Initial finding",
			body: "Body A.",
			severity: "medium",
		});
		const id = (created.details as IssuesToolDetails).id!;

		const edited = await tool.execute("tc-2", {
			op: "edit",
			id,
			title: "Renamed finding",
			severity: "high",
		});
		const editDetails = edited.details as IssuesToolDetails;
		expect(editDetails.renamed).toBe(true);
		expect(editDetails.transitioned).toBe(false);
		expect(editDetails.filename).toBe(`${id}-renamed-finding.md`);
		expect(editDetails.severity).toBe("high");

		const archived = await tool.execute("tc-3", {
			op: "archive",
			id,
			reason: "fixed in #321",
		});
		const archiveDetails = archived.details as IssuesToolDetails;
		expect(archiveDetails.archived).toBe(true);
		const record = await findIssueById(tempDir, id);
		expect(record?.archived).toBe(true);
		expect(record?.frontmatter.archive_reason).toBe("fixed in #321");

		const restored = await tool.execute("tc-4", {
			op: "unarchive",
			id,
		});
		const restoreDetails = restored.details as IssuesToolDetails;
		expect(restoreDetails.archived).toBe(false);
		const back = await findIssueById(tempDir, id);
		expect(back?.archived).toBe(false);
		expect(back?.frontmatter.status).toBe("open");
	});

	it("edit with a terminal status auto-archives; reopening status auto-restores", async () => {
		const tool = makeTool(tempDir);
		const created = await tool.execute("tx-1", {
			op: "add",
			category: "security",
			title: "Status transition",
			body: "Body.",
		});
		const id = (created.details as IssuesToolDetails).id!;

		const closed = await tool.execute("tx-2", { op: "edit", id, status: "fixed" });
		const closedDetails = closed.details as IssuesToolDetails;
		expect(closedDetails.transitioned).toBe(true);
		expect(closedDetails.archived).toBe(true);
		const closedText = closed.content.find(c => c.type === "text")?.text ?? "";
		expect(closedText).toMatch(/moved → archive/);
		expect(closedText).toMatch(/\(archived\)/);
		// Reachable through findIssueById (which scans both sides).
		const onArchive = await findIssueById(tempDir, id);
		expect(onArchive?.archived).toBe(true);

		const reopened = await tool.execute("tx-3", { op: "edit", id, status: "open" });
		const reopenedDetails = reopened.details as IssuesToolDetails;
		expect(reopenedDetails.transitioned).toBe(true);
		expect(reopenedDetails.archived).toBe(false);
		expect((await findIssueById(tempDir, id))?.archived).toBe(false);
	});

	it("list returns scope-aware markdown and includes severity filters", async () => {
		const tool = makeTool(tempDir);
		await tool.execute("a", {
			op: "add",
			category: "security",
			title: "Critical leak",
			body: "Body.",
			severity: "critical",
		});
		await tool.execute("b", {
			op: "add",
			category: "correctness",
			title: "Minor nit",
			body: "Body.",
			severity: "low",
		});

		const listAll = await tool.execute("l1", { op: "list" });
		const listAllText = listAll.content.find(c => c.type === "text")?.text ?? "";
		expect(listAllText).toContain("active+archive");
		expect(listAllText).toContain("Critical leak");
		expect(listAllText).toContain("Minor nit");

		const listCritical = await tool.execute("l2", { op: "list", severity: "critical" });
		const listCriticalText = listCritical.content.find(c => c.type === "text")?.text ?? "";
		expect(listCriticalText).toContain("Critical leak");
		expect(listCriticalText).not.toContain("Minor nit");
	});

	it("rejects unknown ids on edit/archive/unarchive", async () => {
		const tool = makeTool(tempDir);
		await expect(tool.execute("e1", { op: "edit", id: 999, title: "x" })).rejects.toThrow(/Issue #999 not found/);
		await expect(tool.execute("a1", { op: "archive", id: 999 })).rejects.toThrow(/Issue #999 not found/);
		await expect(tool.execute("u1", { op: "unarchive", id: 999 })).rejects.toThrow(/Issue #999 not found/);
	});

	it("createIf returns null when issues.enabled is false", () => {
		const session = createSession(tempDir);
		session.settings.set("issues.enabled", false);
		expect(IssuesTool.createIf(session)).toBeNull();
	});
});
