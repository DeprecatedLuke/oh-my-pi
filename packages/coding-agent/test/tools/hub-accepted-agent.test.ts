/**
 * Hub watchdog surface (#11079): an agent whose final result was accepted but
 * that never reached a terminal status must be reported as actionable state by
 * `hub`'s running-agents snapshot, not silently left in the running roster.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

const SELF_ID = "Main";

describe("hub accepted-agent watchdog", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function makeSession(manager: AsyncJobManager): ToolSession {
		// Structurally-partial test session: the running-agents snapshot only
		// touches the registry, manager, and caller id.
		return {
			agentRegistry: registry,
			asyncJobManager: manager,
			getAgentId: () => SELF_ID,
		} as unknown as ToolSession;
	}

	function registerLeakedAcceptedRun(): void {
		let streaming = true;
		const session = {
			get isStreaming(): boolean {
				return streaming;
			},
		} as never;
		const ref = registry.register({
			id: "PolicyCommand",
			displayName: "PolicyCommand",
			kind: "sub",
			parentId: SELF_ID,
			session,
			status: "running",
		});
		// Acceptance lands while the wake turn is in flight, so the ref is not
		// terminalized yet; the turn then ends without the mirror delivering
		// `idle` — the leak the roster must report.
		registry.markResultAccepted("PolicyCommand", ref, ref.createdAt);
		streaming = false;
	}

	it("surfaces an accepted-but-running agent with its acceptance age and a cancel hint", async () => {
		const manager = new AsyncJobManager({});
		try {
			registerLeakedAcceptedRun();

			const result = await new HubTool(makeSession(manager)).execute("accepted_agent", { op: "jobs" });
			const details = result.details;
			if (!details || details.op !== "jobs") throw new Error("Expected jobs snapshot");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(text).toContain("final result accepted");
			expect(text).toContain("hub` cancel");
			expect(details.agents?.map(agent => agent.id)).toEqual(["PolicyCommand"]);
			expect(details.agents?.[0]?.acceptedAt).toBeNumber();
		} finally {
			await manager.dispose();
		}
	});
});
