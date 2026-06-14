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

	it("archive then unarchive moves the file and round-trips status", async () => {
		const tool = makeTool(tempDir);
		const created = await tool.execute("tc-1", {
			op: "add",
			category: "security",
			title: "Initial finding",
			body: "Body A.",
			severity: "medium",
		});
		const id = (created.details as IssuesToolDetails).id!;

		const archived = await tool.execute("tc-2", {
			op: "archive",
			id,
			reason: "fixed in #321",
		});
		const archiveDetails = archived.details as IssuesToolDetails;
		expect(archiveDetails.archived).toBe(true);
		const record = await findIssueById(tempDir, id);
		expect(record?.archived).toBe(true);
		expect(record?.frontmatter.archive_reason).toBe("fixed in #321");

		const restored = await tool.execute("tc-3", {
			op: "unarchive",
			id,
		});
		const restoreDetails = restored.details as IssuesToolDetails;
		expect(restoreDetails.archived).toBe(false);
		const back = await findIssueById(tempDir, id);
		expect(back?.archived).toBe(false);
		expect(back?.frontmatter.status).toBe("open");
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

	it("rejects unknown ids on archive/unarchive", async () => {
		const tool = makeTool(tempDir);
		await expect(tool.execute("a1", { op: "archive", id: 999 })).rejects.toThrow(/Issue #999 not found/);
		await expect(tool.execute("u1", { op: "unarchive", id: 999 })).rejects.toThrow(/Issue #999 not found/);
	});

	it("createIf returns null when issues.enabled is false", () => {
		const session = createSession(tempDir);
		session.settings.set("issues.enabled", false);
		expect(IssuesTool.createIf(session)).toBeNull();
	});
});
