import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeFileHash } from "@oh-my-pi/hashline";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { getKnowledgeRoot } from "@oh-my-pi/pi-coding-agent/session/knowledge-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	} as unknown as ToolSession;
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const KNOWLEDGE_FILE = "testing/edit-url.md";
const BASE_CONTENT = "---\ndescription: testing, edit url\n---\n\n# Edit URL\n\n- Original durable fact.\n";

function knowledgeAbsPath(cwd: string): string {
	return path.join(getKnowledgeRoot(cwd), ...KNOWLEDGE_FILE.split("/"));
}

describe("edit tool knowledge:// support", () => {
	let tmpDir: string;
	let savedEditVariant: string | undefined;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		// Pin to the default (hashline) edit mode regardless of the host env.
		savedEditVariant = Bun.env.PI_EDIT_VARIANT;
		delete Bun.env.PI_EDIT_VARIANT;
		InternalUrlRouter.resetForTests();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-knowledge-url-"));
		await Bun.write(knowledgeAbsPath(tmpDir), BASE_CONTENT);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		InternalUrlRouter.resetForTests();
		if (savedEditVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
		else Bun.env.PI_EDIT_VARIANT = savedEditVariant;
	});

	/** Resolve the live knowledge content and build a hashline op that replaces its body line. */
	async function buildEditInput(): Promise<string> {
		const resource = await InternalUrlRouter.instance().resolve(`knowledge://${KNOWLEDGE_FILE}`, { cwd: tmpDir });
		const tag = computeFileHash(resource.content);
		return `[knowledge://${KNOWLEDGE_FILE}#${tag}]\nSWAP 7.=7:\n+- Edited durable fact.`;
	}

	/** Build the same body edit addressed by the on-disk filesystem path instead of the URL. */
	async function buildFsEditInput(): Promise<string> {
		const relPath = path.join(".omp", "knowledge", ...KNOWLEDGE_FILE.split("/"));
		const tag = computeFileHash(await Bun.file(knowledgeAbsPath(tmpDir)).text());
		return `[${relPath}#${tag}]\nSWAP 7.=7:\n+- Edited durable fact.`;
	}

	it("rewrites a knowledge file through the knowledge:// URL handler", async () => {
		const tool = new EditTool(createSession(tmpDir));
		expect(tool.mode).toBe("hashline");
		const input = await buildEditInput();

		const result = await tool.execute("call-1", { input });

		// The tool echoes a fresh [knowledge://...#TAG] header (tag computed from resolved content).
		expect(resultText(result)).toContain(`[knowledge://${KNOWLEDGE_FILE}#`);
		// The handler persisted the edit to disk.
		const onDisk = await Bun.file(knowledgeAbsPath(tmpDir)).text();
		expect(onDisk).toContain("- Edited durable fact.");
		expect(onDisk).not.toContain("- Original durable fact.");
	});

	it("rejects knowledge edits through a category symlink that escapes the knowledge root", async () => {
		const knowledgeRoot = getKnowledgeRoot(tmpDir);
		const outsidePath = path.join(tmpDir, "outside-topic.md");
		const escapedCategory = path.join(knowledgeRoot, "escaped");
		await fs.mkdir(knowledgeRoot, { recursive: true });
		await fs.writeFile(outsidePath, BASE_CONTENT);
		await fs.symlink(path.dirname(outsidePath), escapedCategory, "dir");
		const before = await fs.readFile(outsidePath, "utf8");
		const tag = computeFileHash(before);
		const input = `[knowledge://escaped/${path.basename(outsidePath)}#${tag}]\nSWAP 7.=7:\n+- Must not edit outside knowledge root.`;

		await expect(new EditTool(createSession(tmpDir)).execute("call-escape", { input })).rejects.toThrow(
			/knowledge:\/\/ URL escapes knowledge root/,
		);
		expect(await fs.readFile(outsidePath, "utf8")).toBe(before);
	});

	it("leaves normal filesystem hashline edits on the filesystem path", async () => {
		const filePath = path.join(tmpDir, "plain.md");
		await Bun.write(filePath, "# Plain\n\n- keep me\n");
		const tool = new EditTool(createSession(tmpDir));
		const tag = computeFileHash(await Bun.file(filePath).text());
		const input = `[${filePath}#${tag}]\nSWAP 3.=3:\n+- changed me`;

		const result = await tool.execute("call-3", { input });

		// The filesystem hashline renderer relativizes the header to the cwd, so a
		// plain path comes back as [plain.md#TAG] — proof the normal path ran (the
		// internal-URL branch never resolves a non-scheme path).
		expect(resultText(result)).toContain("[plain.md#");
		const onDisk = await Bun.file(filePath).text();
		expect(onDisk).toContain("- changed me");
		expect(onDisk).not.toContain("- keep me");
	});

	it("edits a knowledge file via its filesystem path under .omp/knowledge", async () => {
		const tool = new EditTool(createSession(tmpDir));
		const input = await buildFsEditInput();

		const result = await tool.execute("call-5", { input });

		expect(resultText(result)).toContain(".omp/knowledge/");
		const onDisk = await Bun.file(knowledgeAbsPath(tmpDir)).text();
		expect(onDisk).toContain("- Edited durable fact.");
		expect(onDisk).not.toContain("- Original durable fact.");
	});
});
