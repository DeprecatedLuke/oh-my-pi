/**
 * `hub wait` routes peer-message waits while rejecting removed background-job
 * blocking. Job snapshots and automatic delivery are covered by the job suites.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager | undefined): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

/** Register a job that never settles on its own; returns its id. */
function registerHangingJob(manager: AsyncJobManager, label: string): string {
	return manager.register("bash", label, () => new Promise<string>(() => {}), { ownerId: SELF_ID });
}

describe("hub peer-message wait routing", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a from-scoped wait consumes matching peer messages while jobs stay untouched", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerHangingJob(manager, "sleep forever");
		const tool = new HubTool(makeSession(manager));

		// The bus waiter is parked synchronously before execute()'s first
		// suspension, so the send below cannot race the park.
		const pending = tool.execute("call_1", { op: "wait", from: "Peer" });
		await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "shared file is yours" });

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(result.isError).not.toBe(true);
		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("shared file is yours");
		// The message win does not settle or cancel an unrelated running job.
		expect(manager.getJob(jobId)?.status).toBe("running");

		manager.cancel(jobId);
	});

	test("rejects background-job waits without settling or cancelling jobs", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerHangingJob(manager, "sleep forever");
		const tool = new HubTool(makeSession(manager));

		const bare = await tool.execute("call_bare", { op: "wait" });
		const byId = await tool.execute("call_ids", { op: "wait", ids: [jobId] });
		const fromAndIds = await tool.execute("call_from_ids", { op: "wait", from: "Peer", ids: [jobId] });
		const fromAndEmptyIds = await tool.execute("call_from_empty_ids", { op: "wait", from: "Peer", ids: [] });
		for (const result of [bare, byId, fromAndIds, fromAndEmptyIds]) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(result.isError).toBe(true);
			expect(text).toContain("Background-job waiting is disabled");
			expect(text).toContain("auto-deliver");
			expect(text).toContain("End the turn immediately");
			expect(manager.getJob(jobId)?.status).toBe("running");
		}

		manager.cancel(jobId);
	});

	test("bare wait rejects immediately when nothing is running", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_no_jobs", { op: "wait" });
		const details = result.details as CoordinationDetails;
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.isError).toBe(true);
		expect(details.op).toBe("wait");
		expect(details.jobs).toBeUndefined();
		expect(text).toContain("Background-job waiting is disabled");
		expect(text).toContain("auto-deliver");
	});

	test("bare wait does not treat agents outside job control as background jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({
			id: "Worker",
			displayName: "worker",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_agent_only", { op: "wait" });
		const details = result.details as CoordinationDetails;
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.isError).toBe(true);
		expect(details.op).toBe("wait");
		expect(details.agents).toBeUndefined();
		expect(text).toContain("Background-job waiting is disabled");
		expect(text).toContain("End the turn immediately");
	});

	test("explicit agent ids with no matching job are rejected without polling", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({
			id: "Worker",
			displayName: "worker",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_missing_job", {
			op: "wait",
			ids: ["Worker"],
		});
		const details = result.details as CoordinationDetails;
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.isError).toBe(true);
		expect(details.op).toBe("wait");
		expect(details.jobs).toBeUndefined();
		expect(text).toContain("Background-job waiting is disabled");
		expect(text).toContain("auto-deliver");
	});

	test("bare wait ignores a detached ref whose running status is stale", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({
			id: "Zombie",
			displayName: "stale task",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "running",
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		// `timeoutMs: 0` would block forever if the stale ref still opened the
		// message-wait gate; the test times out instead of asserting.
		const result = await new HubTool(makeSession(manager)).execute("call_4", { op: "wait", timeoutMs: 0 });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("No running background jobs to wait for.");
		// The stale ref is reported (not silently dropped): it is the only handle
		// the caller has for clearing it with `hub cancel`.
		expect(text).toContain("Zombie");
		expect(text).toContain("no turn in flight");
	});

	test("bare wait returns a message already queued on the bus", async () => {
		const registry = AgentRegistry.global();
		// A recipient whose live hand-off throws is the only way a message
		// reaches the mailbox: `IrcBus.send` buffers solely from that catch.
		registry.register({
			id: SELF_ID,
			displayName: "main",
			kind: "main",
			session: {
				deliverIrcMessage: () => Promise.reject(new Error("session disposed")),
			},
		} as unknown as Parameters<AgentRegistry["register"]>[0]);
		// Idle peer: nothing is running, so the liveness gate would otherwise
		// short-circuit the wait before the mailbox is ever consulted.
		registry.register({ id: "Peer", displayName: "task", kind: "sub", session: null, status: "idle" });

		const firstReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "picked up the lock" });
		const secondReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "starting the edit" });
		expect(firstReceipt.outcome).toBe("failed");
		expect(secondReceipt.outcome).toBe("failed");
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(2);

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_5", { op: "wait" });
		const details = result.details as CoordinationDetails;

		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("picked up the lock");
		// Consumed exactly one message, not merely peeked or drained the backlog.
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(1);
		expect(
			IrcBus.global()
				.inbox(SELF_ID)
				.map(message => message.body),
		).toEqual(["starting the edit"]);
	});
});
