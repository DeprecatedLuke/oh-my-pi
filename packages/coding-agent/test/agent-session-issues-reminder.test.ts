import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { addIssue } from "@oh-my-pi/pi-coding-agent/issues";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// The in-progress issues reminder mirrors the todo-completion reminder: at the
// end of a turn (final assistant stop, no tool calls), if any issue is still
// marked `in-progress` and no background jobs are running, append a
// <system-reminder> and schedule a continue. It is capped (issues.reminders.max)
// and reset on a new prompt, exactly like the todo path, so a stuck issue cannot
// loop forever.
//
// Determinism: the agent_end handler runs fire-and-forget (Agent#emit does not
// await listeners), but the end-of-turn reminder runs as a *tracked* post-prompt
// task, so `waitForIdle()` drains it (append + any scheduled continue cascade)
// before returning. Every case therefore uses a uniform prompt() + waitForIdle().

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
	mock: MockModel;
};
type SettingsOverrides = Partial<Record<SettingPath, unknown>>;

const activeHarnesses: Harness[] = [];

/** A plain text stop — drives one end-of-turn through the agent_end handler. */
function textStop(): MockResponse {
	return { content: ["Done."], stopReason: "stop", usage: { output: 1, cacheRead: 100 } };
}

async function createHarness(settingsOverrides: SettingsOverrides = {}, responseCount = 8): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-issues-reminder-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses: Array.from({ length: responseCount }, () => textStop()) });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		// Isolate the issues reminder from the todo reminder path.
		"todo.enabled": false,
		"todo.eager": false,
		"todo.reminders": false,
		"issues.enabled": true,
		"issues.reminders": true,
		...settingsOverrides,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	// cwd === tempDir so the reminder's `listIssues(cwd)` reads issues seeded here.
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	const harness = { session, authStorage, tempDir, mock };
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		try {
			await harness.session.dispose();
		} catch {}
		harness.authStorage.close();
		try {
			await harness.tempDir.remove();
		} catch {}
	}
	vi.restoreAllMocks();
});

/** Text of an in-progress issue reminder, or undefined if `message` is not one. */
function issueReminderText(message: AgentMessage): string | undefined {
	if (message.role !== "developer") return undefined;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
	return text.includes("<system-reminder>") && text.includes("in-progress") ? text : undefined;
}

/** Developer reminder messages naming in-progress issues, in append order. */
function issueReminders(messages: AgentMessage[]): string[] {
	return messages.map(issueReminderText).filter((text): text is string => text !== undefined);
}

describe("AgentSession in-progress issues reminder", () => {
	it("reminds and continues when an issue is in-progress and no background jobs run", async () => {
		const { session, tempDir, mock } = await createHarness({ "issues.reminders.max": 1 });
		await addIssue(tempDir.path(), {
			category: "security",
			title: "Sanitize the egress path",
			body: "WIP.",
			status: "in-progress",
		});

		await session.prompt("do the thing");
		await session.waitForIdle();

		const reminders = issueReminders(session.agent.state.messages);
		// max=1 → exactly one reminder, then the next turn hits the cap and settles.
		expect(reminders).toHaveLength(1);
		// Names the concrete issue and offers the actionable escape hatch.
		expect(reminders[0]).toContain("#1 Sanitize the egress path");
		expect(reminders[0]).toContain("set it back to open");
		expect(reminders[0]).toContain("(Reminder 1/1)");
		// The reminder scheduled a continue → the mock saw the follow-up turn.
		expect(mock.calls.length).toBe(2);
	});

	it("does NOT remind while a background job is running (the no-bg-jobs gate)", async () => {
		const { session, tempDir, mock } = await createHarness();
		await addIssue(tempDir.path(), {
			category: "security",
			title: "Held while a job runs",
			body: "WIP.",
			status: "in-progress",
		});
		// Simulate background work in flight: the turn is not really ending, so the
		// reminder must be withheld and no continue scheduled.
		vi.spyOn(session, "hasPendingBackgroundJobs").mockReturnValue(true);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(issueReminders(session.agent.state.messages)).toHaveLength(0);
		// No reminder → no scheduled continue → only the original turn ran.
		expect(mock.calls.length).toBe(1);
	});

	it("does NOT remind when no issue is in-progress (open issues are ignored)", async () => {
		const { session, tempDir, mock } = await createHarness();
		await addIssue(tempDir.path(), {
			category: "security",
			title: "Just an open issue",
			body: "Not started.",
			status: "open",
		});

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(issueReminders(session.agent.state.messages)).toHaveLength(0);
		expect(mock.calls.length).toBe(1);
	});

	it("stops reminding after issues.reminders.max consecutive turns", async () => {
		const { session, tempDir, mock } = await createHarness({ "issues.reminders.max": 2 });
		await addIssue(tempDir.path(), {
			category: "security",
			title: "Stuck in-progress",
			body: "WIP.",
			status: "in-progress",
		});

		await session.prompt("do the thing");
		await session.waitForIdle();

		// Cap = 2 → two reminders, then the third turn is capped and the cascade ends.
		const reminders = issueReminders(session.agent.state.messages);
		expect(reminders).toHaveLength(2);
		expect(reminders[0]).toContain("(Reminder 1/2)");
		expect(reminders[1]).toContain("(Reminder 2/2)");
		// initial turn + 2 continues = 3 mock calls; the capped turn schedules none.
		expect(mock.calls.length).toBe(3);
	});

	it("is silent when issue reminders are disabled even with an in-progress issue", async () => {
		const { session, tempDir, mock } = await createHarness({ "issues.reminders": false });
		await addIssue(tempDir.path(), {
			category: "security",
			title: "Disabled reminders",
			body: "WIP.",
			status: "in-progress",
		});

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(issueReminders(session.agent.state.messages)).toHaveLength(0);
		expect(mock.calls.length).toBe(1);
	});
});
