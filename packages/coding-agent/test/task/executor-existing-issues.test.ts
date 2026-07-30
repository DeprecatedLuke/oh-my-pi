/**
 * Verifies that subagents holding the `issues` tool (the reviewer) get the
 * catalogued issues injected into their system prompt at spawn, so they
 * edit/respect existing entries instead of re-filing duplicates or items
 * already settled as wontfix/duplicate. Agents without the tool get no section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { addIssue, archiveIssue } from "@oh-my-pi/pi-coding-agent/issues";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-issues-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function createMockSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["issues", "yield"],
		getEnabledToolNames: () => ["issues", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tc-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: {
							status: "success",
							data: {
								overall_correctness: "correct",
								explanation: "No defects found.",
								confidence: 1,
							},
						},
					},
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {
			extensions: [],
			errors: [],
			runtime: {} as unknown,
		} as unknown as CreateAgentSessionResult["extensionsResult"],
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function reviewerAgent(tools: string[]): AgentDefinition {
	return { name: "reviewer", description: "review", systemPrompt: "Review the patch.", tools, source: "bundled" };
}

async function renderedSubagentPrompt(cwd: string, agent: AgentDefinition): Promise<string> {
	const session = createMockSession();
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
	const result = await runSubprocess({
		cwd,
		agent,
		task: "review",
		index: 0,
		id: "subagent-existing-issues",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as Parameters<typeof runSubprocess>[0]["modelRegistry"],
		enableLsp: false,
	});
	expect(result.exitCode, result.stderr || result.output).toBe(0);
	const systemPrompt = spy.mock.calls[0]?.[0]?.systemPrompt;
	if (typeof systemPrompt !== "function") throw new Error("expected systemPrompt callback");
	const rendered = systemPrompt([]);
	return Array.isArray(rendered) ? rendered.join("\n") : rendered;
}

describe("runSubprocess existing-issue awareness", () => {
	it("injects catalogued issues and settled-status guidance for the bundled reviewer", async () => {
		await addIssue(tempDir, {
			category: "correctness",
			title: "Open race in scheduler",
			body: "Race condition.",
			severity: "high",
		});
		const settled = await addIssue(tempDir, {
			category: "security",
			title: "Rejected hardening request",
			body: "Out of scope.",
			severity: "low",
		});
		await archiveIssue(tempDir, settled.record.id, { status: "wontfix" });

		const { agents } = await discoverAgents(tempDir, tempDir);
		const reviewer = agents.find(agent => agent.name === "reviewer");
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.tools).toContain("issues");
		const rendered = await renderedSubagentPrompt(tempDir, { ...reviewer!, model: undefined });

		expect(rendered).toContain("FILED ISSUES");
		expect(rendered).toContain("Open race in scheduler");
		expect(rendered).toContain("Rejected hardening request");
		// Settled decisions are flagged so the reviewer skips them.
		expect(rendered).toContain("wontfix");
		expect(rendered).toContain("(archived)");
		expect(rendered).toContain("NEVER re-file");
	});

	it("renders an explicit empty marker when no issues are filed yet", async () => {
		const rendered = await renderedSubagentPrompt(tempDir, reviewerAgent(["read", "issues"]));
		expect(rendered).toContain("FILED ISSUES");
		expect(rendered).toContain("No issues filed yet");
	});

	it("omits the FILED ISSUES section for agents without the issues tool", async () => {
		await addIssue(tempDir, { category: "correctness", title: "Some open issue", body: "Body." });
		const rendered = await renderedSubagentPrompt(tempDir, reviewerAgent(["read", "search"]));
		expect(rendered).not.toContain("FILED ISSUES");
		expect(rendered).not.toContain("Some open issue");
	});
});
