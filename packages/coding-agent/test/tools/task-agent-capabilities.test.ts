import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled scout as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "scout"))).toBe(true);
		for (const name of ["task", "sonic", "reviewer", "designer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("restricts the research agent to web tools — no repo, file, or command access", () => {
		const research = agentByName(loadBundledAgents(), "research");
		const tools = research.tools ?? [];

		// The defining guarantee: research reasons from the web only.
		expect(tools).toContain("web_search");
		expect(tools).toContain("browser");
		for (const forbidden of ["read", "write", "edit", "bash", "search", "find", "lsp", "ast_grep", "ast_edit"]) {
			expect(tools).not.toContain(forbidden);
		}
	});

	it("disables read summarization for scout and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "sonic", "reviewer", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
	it("ships every bundled agent without prewalk; hand-off is opt-in via task.agentPrewalk", () => {
		const agents = loadBundledAgents();

		for (const name of ["task", "scout", "sonic", "reviewer", "designer", "librarian"]) {
			expect(agentByName(agents, name).prewalk).toBeUndefined();
		}
	});
});
