/**
 * `issues://` URL handler tests. Covers listing roots, archive listing,
 * filename resolution (full + id-only), query filter, error surface, and
 * the read-only contract (write must point to the tool).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { addIssue, archiveIssue } from "@oh-my-pi/pi-coding-agent/issues";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issues-protocol-"));
	InternalUrlRouter.resetForTests();
});

afterEach(async () => {
	InternalUrlRouter.resetForTests();
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("IssuesProtocolHandler", () => {
	it("lists active issues at issues:// and excludes archived ones", async () => {
		const a = await addIssue(tempDir, {
			category: "security",
			title: "Allow-all egress",
			body: "Wide open.",
			severity: "high",
		});
		const b = await addIssue(tempDir, {
			category: "correctness",
			title: "Off-by-one chunk",
			body: "Skips final item.",
			severity: "medium",
		});
		await archiveIssue(tempDir, b.record.id, { reason: "Fixed in #3" });

		const active = await InternalUrlRouter.instance().resolve("issues://", { cwd: tempDir });
		expect(active.content).toContain(`#${a.record.id}`);
		expect(active.content).toContain("Allow-all egress");
		// `issues://` is active-only.
		expect(active.content).not.toContain("Off-by-one chunk");
		expect(active.immutable).toBe(true);
	});

	it("lists archived issues at issues://archive", async () => {
		const { record } = await addIssue(tempDir, {
			category: "correctness",
			title: "Off-by-one chunk",
			body: "Skips final item.",
		});
		await archiveIssue(tempDir, record.id, { reason: "Fixed" });
		const listing = await InternalUrlRouter.instance().resolve("issues://archive", { cwd: tempDir });
		expect(listing.content).toContain("Off-by-one chunk");
		expect(listing.content).toContain(`issues://${record.filename}`);
	});

	it("filters listings via ?q=", async () => {
		await addIssue(tempDir, {
			category: "security",
			title: "Allow-all egress",
			body: "Network is open.",
		});
		await addIssue(tempDir, {
			category: "correctness",
			title: "Off-by-one chunk",
			body: "Skips final item.",
		});

		const filtered = await InternalUrlRouter.instance().resolve("issues://?q=chunk", { cwd: tempDir });
		expect(filtered.content).toContain("Off-by-one chunk");
		expect(filtered.content).not.toContain("Allow-all egress");
	});

	it("resolves issues by full filename and by id-only basename", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Reset password leak",
			body: "Body content.",
		});

		const byName = await InternalUrlRouter.instance().resolve(`issues://${record.filename}`, {
			cwd: tempDir,
		});
		const byId = await InternalUrlRouter.instance().resolve(`issues://${record.id}.md`, { cwd: tempDir });

		expect(byName.content).toContain("Reset password leak");
		expect(byName.sourcePath).toBe(record.filePath);
		expect(byId.content).toBe(byName.content);
	});

	it("falls back to archive when reading an issue that was moved", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Quick fix",
			body: "B.",
		});
		await archiveIssue(tempDir, record.id);

		const found = await InternalUrlRouter.instance().resolve(`issues://${record.filename}`, {
			cwd: tempDir,
		});
		expect(found.content).toContain("Quick fix");
		expect(found.sourcePath).toContain(`${path.sep}archive${path.sep}`);
	});

	it("rejects malformed URLs with a clear message", async () => {
		await expect(
			InternalUrlRouter.instance().resolve("issues://security/14-foo.md", { cwd: tempDir }),
		).rejects.toThrow(/Invalid issues:\/\/ URL/);
		await expect(InternalUrlRouter.instance().resolve("issues://9999.md", { cwd: tempDir })).rejects.toThrow(
			/Issue not found/,
		);
	});

	it("write through the handler updates the issue file and round-trips through read", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Editable",
			body: "Initial.",
		});
		const handler = InternalUrlRouter.instance().getHandler("issues");
		if (!handler?.write) throw new Error("issues handler must define write");

		const nextContent = [
			"---",
			`title: Editable`,
			"category: security",
			"status: open",
			"---",
			"",
			"Updated body with new details.",
			"",
		].join("\n");
		const result = await handler.write(parseInternalUrl(`issues://${record.filename}`), nextContent, {
			cwd: tempDir,
		});
		expect(result?.text).toContain(`issues://${record.filename}`);

		const read = await InternalUrlRouter.instance().resolve(`issues://${record.filename}`, { cwd: tempDir });
		expect(read.content).toContain("Updated body with new details.");
		expect(read.immutable).toBe(false);
	});

	it("rejects writes that destroy the YAML frontmatter", async () => {
		const { record } = await addIssue(tempDir, {
			category: "security",
			title: "Frontmatter guard",
			body: "Body.",
		});
		const handler = InternalUrlRouter.instance().getHandler("issues");
		if (!handler?.write) throw new Error("issues handler must define write");

		const broken = ["---", "title: [unclosed", "---", "", "Body."].join("\n");
		await expect(
			handler.write(parseInternalUrl(`issues://${record.filename}`), broken, { cwd: tempDir }),
		).rejects.toThrow(/does not parse as YAML frontmatter/);
	});

	it("rejects writes to listing URLs and points at the tool", async () => {
		const handler = InternalUrlRouter.instance().getHandler("issues");
		if (!handler?.write) throw new Error("issues handler must define write");
		await expect(handler.write(parseInternalUrl("issues://"), "stuff", { cwd: tempDir })).rejects.toThrow(
			/writes target a single issue file/i,
		);
		await expect(handler.write(parseInternalUrl("issues://archive"), "stuff", { cwd: tempDir })).rejects.toThrow(
			/writes target a single issue file/i,
		);
	});
});
