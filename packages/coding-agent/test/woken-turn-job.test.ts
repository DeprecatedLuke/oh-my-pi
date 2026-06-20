import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
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
	test("a subagent woken turn becomes a tracked job that delivers on completion", async () => {
		const { manager, completions } = makeManager();
		const gate = Promise.withResolvers<void>();
		let ran = false;
		runWokenTurnTracked({
			manager,
			agentId: "AuthLoader",
			agentKind: "sub",
			runTurn: async () => {
				ran = true;
				await gate.promise;
			},
			summarize: id => `${id} finished a woken turn`,
		});

		// The job is live for the turn's duration, owned by the woken agent, so the
		// Background Jobs panel (which reads getRunningJobs) reflects the woken turn.
		const running = manager.getRunningJobs();
		expect(running.map(j => j.id)).toEqual(["AuthLoader"]);
		expect(running[0]?.ownerId).toBe("AuthLoader");
		expect(ran).toBe(true);

		// Finishing the turn completes the job and delivers a follow-up to the owner.
		gate.resolve();
		await manager.waitForAll();
		expect(await manager.drainDeliveries({ timeoutMs: 1000 })).toBe(true);
		expect(completions).toEqual([{ jobId: "AuthLoader", text: "AuthLoader finished a woken turn" }]);
		await manager.dispose();
	});

	test("the main agent's wake runs untracked — no job, no self-delivery", async () => {
		const { manager, completions } = makeManager();
		let ran = false;
		runWokenTurnTracked({
			manager,
			agentId: undefined,
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
			{ id: "Filler" },
		);
		expect(manager.atCapacity).toBe(true);

		let ran = false;
		runWokenTurnTracked({
			manager,
			agentId: "AuthLoader",
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
			agentKind: "sub",
			runTurn: async () => {
				ran = true;
			},
			summarize: id => id,
		});
		expect(ran).toBe(true);
	});
});
