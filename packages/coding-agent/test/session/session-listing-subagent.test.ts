import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findMostRecentSession, isSubagentSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const storage = new FileSessionStorage();

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-listing-"));
	dirs.push(dir);
	return dir;
}

function line(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

function header(id: string, cwd: string): string {
	return line({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd });
}

/** Write a plain top-level user session (header + one message) and return its path. */
function writePlain(dir: string, id: string): string {
	const file = path.join(dir, `${id}.jsonl`);
	const body = line({
		type: "message",
		id: `${id}-m`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
	fs.writeFileSync(file, header(id, dir) + body);
	return file;
}

/**
 * Write a realistic subagent transcript: a parent session file `<dir>/<parentId>.jsonl`
 * plus its artifacts subdir `<dir>/<parentId>/` holding `<name>.jsonl`. The transcript's
 * `session_init` embeds a deliberately HUGE system prompt (>> the 4 KB prefix window) so a
 * fixed-prefix content scan would miss it — the regression that broke the old detector.
 * Returns the subagent transcript path.
 */
function writeSubagentTranscript(dir: string, parentId: string, name = "Worker"): string {
	const parentFile = path.join(dir, `${parentId}.jsonl`);
	fs.writeFileSync(parentFile, header(parentId, dir));
	const artifactsDir = path.join(dir, parentId);
	fs.mkdirSync(artifactsDir, { recursive: true });
	const file = path.join(artifactsDir, `${name}.jsonl`);
	const hugePrompt = "X".repeat(40_000); // pushes session_init far past SESSION_LIST_PREFIX_BYTES (4096)
	const init = line({
		type: "session_init",
		id: `${name}-init`,
		parentId: null,
		timestamp: new Date().toISOString(),
		systemPrompt: hugePrompt,
		task: "do work",
		tools: [],
	});
	fs.writeFileSync(file, header(`${name}-id`, dir) + init);
	return file;
}

describe("isSubagentSessionFile (path-based)", () => {
	it("detects a subagent transcript whose session_init exceeds the 4 KB prefix window", async () => {
		const dir = freshDir();
		const subagent = writeSubagentTranscript(dir, "parent-1");
		// The 40 KB systemPrompt means a prefix-content scan for `session_init` would return
		// false; path-based detection keys off the parent `.jsonl` sibling, so it still holds.
		expect(await isSubagentSessionFile(subagent, storage)).toBe(true);
	});

	it("returns false for a plain top-level session", async () => {
		const dir = freshDir();
		const plain = writePlain(dir, "plain-1");
		expect(await isSubagentSessionFile(plain, storage)).toBe(false);
	});

	it("returns false for a nonexistent path", async () => {
		const dir = freshDir();
		expect(await isSubagentSessionFile(path.join(dir, "does-not-exist.jsonl"), storage)).toBe(false);
	});
});

describe("findMostRecentSession", () => {
	it("returns the plain session in a normal session dir", async () => {
		const dir = freshDir();
		const plain = writePlain(dir, "plain-2");
		expect(await findMostRecentSession(dir, storage)).toBe(plain);
	});

	it("returns null when pointed at an artifacts dir holding only subagent transcripts", async () => {
		// An artifacts dir IS `<parentSessionFile-without-.jsonl>`; every `.jsonl` inside it is a
		// subagent transcript (its parent `.jsonl` is the sibling), so none is resumable.
		const dir = freshDir();
		writeSubagentTranscript(dir, "parent-3", "WorkerA");
		const artifactsDir = path.join(dir, "parent-3");
		expect(fs.existsSync(path.join(artifactsDir, "WorkerA.jsonl"))).toBe(true);
		expect(await findMostRecentSession(artifactsDir, storage)).toBeNull();
	});

	it("returns null for an empty dir", async () => {
		const dir = freshDir();
		expect(await findMostRecentSession(dir, storage)).toBeNull();
	});
});
