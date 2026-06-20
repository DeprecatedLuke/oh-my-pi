import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runWokenTurnTracked } from "@oh-my-pi/pi-coding-agent/session/woken-turn";

function makeManager(maxRunningJobs = 15) {
	const completions: { jobId: string; text: string }[] = [];
	const manager = new AsyncJobManager({
		maxRunningJobs,
		onJobComplete: batch => {
			for (const c of batch) completions.push({ jobId: c.jobId, text: c.text });
		},
	});
	return { manager, completions };
}

describe("runWokenTurnTracked", () => {
	test("a subagent woken turn becomes a job the main panel surfaces and that delivers on completion", async () => {
		const { manager, completions } = makeManager();
		const gate = Promise.withResolvers<void>();
		let ran = false;
		runWokenTurnTracked({
			manager,
			agentId: "AuthLoader",
			ownerId: MAIN_AGENT_ID,
			agentKind: "sub",
			runTurn: async () => {
				ran = true;
				await gate.promise;
			},
			summarize: id => `${id} finished a woken turn`,
		});

		// The Background Jobs panel reads getAsyncJobSnapshot on the Main session,
		// which filters running jobs to ownerId === MAIN_AGENT_ID. The woken job MUST
		// be owned by Main (not the woken subagent) or that filter drops it and the
		// panel still under-counts — reproduce that exact owner-scoped view here.
		const mainPanelView = manager.getRunningJobs({ ownerId: MAIN_AGENT_ID });
		expect(mainPanelView.map(j => j.id)).toEqual(["AuthLoader"]);
		expect(mainPanelView[0]?.ownerId).toBe(MAIN_AGENT_ID);
		expect(ran).toBe(true);

		// Finishing the turn completes the job and delivers a follow-up to the owner.
		gate.resolve();
		await manager.waitForAll();
		expect(await manager.drainDeliveries({ timeoutMs: 1000 })).toBe(true);
		expect(completions).toEqual([{ jobId: "AuthLoader", text: "AuthLoader finished a woken turn" }]);
		await manager.dispose();
	});

	test("the main agent's own wake runs untracked — no job, no self-delivery", async () => {
		const { manager, completions } = makeManager();
		let ran = false;
		runWokenTurnTracked({
			manager,
			agentId: undefined,
			ownerId: MAIN_AGENT_ID,
			agentKind: "main",
			runTurn: async () => {
				ran = true;
			},
			summarize: () => "should not deliver",
		});
		expect(ran).toBe(true);
		expect(manager.getRunningJobs()).toEqual([]);
		await manager.waitForAll();
		expect(completions).toEqual([]);
		await manager.dispose();
	});

	test("at capacity the woken turn still runs, just untracked", async () => {
		const { manager } = makeManager(1);
		const blocker = Promise.withResolvers<void>();
		manager.register(
			"task",
			"Filler",
			async ({ markRunning }) => {
				markRunning();
				await blocker.promise;
				return "done";
			},
			{ id: "Filler", ownerId: MAIN_AGENT_ID },
		);
		expect(manager.atCapacity).toBe(true);

		let ran = false;
		runWokenTurnTracked({
			manager,
			agentId: "AuthLoader",
			ownerId: MAIN_AGENT_ID,
			agentKind: "sub",
			runTurn: async () => {
				ran = true;
			},
			summarize: id => id,
		});

		// The wake is never dropped, but no job is registered past capacity.
		expect(ran).toBe(true);
		expect(manager.getRunningJobs().map(j => j.id)).toEqual(["Filler"]);
		blocker.resolve();
		await manager.dispose();
	});

	test("with no manager the woken turn still runs", async () => {
		let ran = false;
		runWokenTurnTracked({
			manager: undefined,
			agentId: "AuthLoader",
			ownerId: MAIN_AGENT_ID,
			agentKind: "sub",
			runTurn: async () => {
				ran = true;
			},
			summarize: id => id,
		});
		expect(ran).toBe(true);
	});
});
