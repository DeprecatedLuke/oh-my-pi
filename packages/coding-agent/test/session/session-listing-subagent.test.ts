import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findMostRecentSession,
	isSubagentSessionFile,
	listSessions,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
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

/** Write a plain user session (header + one message) and return its path. */
function writePlain(dir: string, id: string): string {
	const file = path.join(dir, `${id}.jsonl`);
	const body = line({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "hello" },
	});
	fs.writeFileSync(file, header(id, dir) + body);
	return file;
}

/** Write a subagent transcript (header + session_init) and return its path. */
function writeSubagent(dir: string, id: string): string {
	const file = path.join(dir, `${id}.jsonl`);
	const body = line({
		type: "session_init",
		id: "s1",
		parentId: null,
		timestamp: new Date().toISOString(),
		systemPrompt: "x",
		task: "t",
		tools: [],
	});
	fs.writeFileSync(file, header(id, dir) + body);
	return file;
}

describe("isSubagentSessionFile", () => {
	it("returns true only for transcripts carrying a session_init entry", async () => {
		const dir = freshDir();
		const subagentFile = writeSubagent(dir, "sub");
		const plainFile = writePlain(dir, "plain");

		expect(await isSubagentSessionFile(subagentFile, storage)).toBe(true);
		expect(await isSubagentSessionFile(plainFile, storage)).toBe(false);
		expect(await isSubagentSessionFile(path.join(dir, "does-not-exist.jsonl"), storage)).toBe(false);
	});
});

describe("listSessions isSubagent flag", () => {
	it("flags subagent transcripts and leaves plain sessions falsy", async () => {
		const dir = freshDir();
		const subagentFile = writeSubagent(dir, "sub");
		const plainFile = writePlain(dir, "plain");

		const sessions = await listSessions(dir, storage);
		const sub = sessions.find(s => s.path === subagentFile);
		const plain = sessions.find(s => s.path === plainFile);

		expect(sub?.isSubagent).toBe(true);
		expect(plain?.isSubagent).toBeFalsy();
	});
});

describe("findMostRecentSession skips subagents", () => {
	it("returns the latest non-subagent session even when a subagent is newer", async () => {
		const dir = freshDir();
		const plainFile = writePlain(dir, "plain");
		const subagentFile = writeSubagent(dir, "sub");

		// Make the subagent transcript strictly newer than the plain session.
		const older = new Date(Date.now() - 60_000);
		const newer = new Date();
		fs.utimesSync(plainFile, older, older);
		fs.utimesSync(subagentFile, newer, newer);

		expect(await findMostRecentSession(dir, storage)).toBe(plainFile);
	});

	it("returns null when only subagent transcripts exist", async () => {
		const dir = freshDir();
		writeSubagent(dir, "sub");

		expect(await findMostRecentSession(dir, storage)).toBeNull();
	});
});
