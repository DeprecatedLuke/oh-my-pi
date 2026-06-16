import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getTerminalSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

function breadcrumbFile(): string {
	const terminalId = getTerminalId();
	if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
	return path.join(getTerminalSessionsDir(), terminalId);
}

function writeBreadcrumb(cwd: string, sessionFile: string): string {
	const file = breadcrumbFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${cwd}\n${sessionFile}\n`);
	return file;
}

/** The recorded session path is the breadcrumb's second line; null if the file is absent. */
function readBreadcrumbTarget(file: string): string | null {
	if (!fs.existsSync(file)) return null;
	const lines = fs.readFileSync(file, "utf8").split("\n");
	return lines.length >= 2 ? lines[1] : null;
}

/** A genuine (non-subagent) session built through SessionManager. */
async function makeRealSession(cwd: string, dir: string): Promise<string> {
	const session = SessionManager.create(cwd, dir);
	session.appendMessage({ role: "user", content: "real session", timestamp: 1 });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	const file = session.getSessionFile();
	if (!file) throw new Error("Expected persisted session file");
	// close() drains the manager's fire-and-forget breadcrumb write, so callers can
	// rely on the breadcrumb reflecting this session once close() resolves.
	await session.close();
	return file;
}

/**
 * Craft a subagent/task transcript as raw JSONL: a valid session header plus the
 * `session_init` marker the task executor writes for every subagent. Written without
 * SessionManager so it emits no terminal breadcrumb of its own — the only way it can
 * reach `continueRecent` is via a poisoned breadcrumb, which is exactly what we test.
 */
function craftSubagentTranscript(dir: string, cwd: string, name = "subagent.jsonl"): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	const ts = new Date().toISOString();
	const header = { type: "session", version: 2, id: "sub-session-id", timestamp: ts, cwd };
	const init = {
		type: "session_init",
		id: "init-1",
		parentId: null,
		timestamp: ts,
		systemPrompt: "subagent system prompt",
		task: "subagent task",
		tools: ["read"],
	};
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(init)}\n`);
	return file;
}

describe("SessionManager.continueRecent skips subagent transcripts", () => {
	let testAgentDir: string;
	let cwd: string;
	let sessionDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%skip-subagent-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-skip-subagent-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		sessionDir = path.join(testAgentDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("resumes the latest real session when the breadcrumb points at a subagent transcript", async () => {
		const realFile = await makeRealSession(cwd, sessionDir);
		// The subagent transcript lives in the real session's artifacts subdir, so the
		// non-recursive session scan never sees it — a poisoned breadcrumb is its only leak.
		const subagentDir = path.join(path.dirname(realFile), path.basename(realFile, ".jsonl"));
		const subagentFile = craftSubagentTranscript(subagentDir, cwd);

		// makeRealSession's breadcrumb write has drained (it awaited close), so this sync
		// write is the final breadcrumb state: it deliberately points at the subagent.
		writeBreadcrumb(cwd, subagentFile);

		const resumed = await SessionManager.continueRecent(cwd, sessionDir);
		try {
			const resumedFile = resumed.getSessionFile();
			if (!resumedFile) throw new Error("Expected a resumed session file");
			// Never resume the subagent transcript; fall back to the real session in the dir.
			expect(path.resolve(resumedFile)).not.toBe(path.resolve(subagentFile));
			expect(path.resolve(resumedFile)).toBe(path.resolve(realFile));
		} finally {
			await resumed.close();
		}
	});

	it("never resumes the subagent and starts fresh when the breadcrumb's only target is a subagent transcript", async () => {
		// No resumable session in the scanned dir. The breadcrumb's target is a subagent
		// transcript inside a parent session's artifacts subdir (the parent `.jsonl` sibling
		// exists, which is how it is detected), so continueRecent must refuse it and start
		// fresh rather than resume it.
		const otherDir = path.join(testAgentDir, "other-sessions");
		fs.mkdirSync(otherDir, { recursive: true });
		const parentFile = path.join(otherDir, "parent.jsonl");
		const ts = new Date().toISOString();
		fs.writeFileSync(
			parentFile,
			`${JSON.stringify({ type: "session", version: 2, id: "parent-id", timestamp: ts, cwd })}\n`,
		);
		const subagentFile = craftSubagentTranscript(path.join(otherDir, "parent"), cwd);
		writeBreadcrumb(cwd, subagentFile);

		const resumed = await SessionManager.continueRecent(cwd, sessionDir);
		try {
			const resumedFile = resumed.getSessionFile();
			// A brand-new session may have no file yet; whatever it is, it is not the subagent.
			if (resumedFile) {
				expect(path.resolve(resumedFile)).not.toBe(path.resolve(subagentFile));
			}
			// Nothing was resumed, so the fresh session carries no history.
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			await resumed.close();
		}
	});

	it("open() suppresses the terminal breadcrumb for a subagent transcript but not a real session", async () => {
		const realFile = await makeRealSession(cwd, sessionDir);
		const subagentDir = path.join(path.dirname(realFile), path.basename(realFile, ".jsonl"));
		const subagentFile = craftSubagentTranscript(subagentDir, cwd);
		const crumb = breadcrumbFile();

		// Suppressed open of the subagent transcript: same file/op as the contrast below,
		// only the flag differs. It must not repoint the breadcrumb at the subagent.
		const suppressed = await SessionManager.open(subagentFile, undefined, undefined, { suppressBreadcrumb: true });
		try {
			const afterSuppressed = readBreadcrumbTarget(crumb);
			// Either absent or its prior value (the real session) — never the subagent.
			expect(afterSuppressed).not.toBe(path.resolve(subagentFile));
		} finally {
			await suppressed.close();
		}

		// Contrast: a plain open DOES write the breadcrumb. Seed a distinct sentinel first so
		// the post-open value proves a write happened rather than echoing a prior state.
		writeBreadcrumb(cwd, path.join(sessionDir, "sentinel-never-opened.jsonl"));
		const opened = await SessionManager.open(realFile);
		try {
			expect(readBreadcrumbTarget(crumb)).toBe(path.resolve(realFile));
		} finally {
			await opened.close();
		}
	});
});
