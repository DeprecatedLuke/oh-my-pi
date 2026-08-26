import { describe, expect, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

async function waitForJobEviction(manager: AsyncJobManager, jobId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (manager.getJob(jobId)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for job eviction: ${jobId}`);
		await scheduler.yield();
	}
}

describe("AsyncJobManager", () => {
	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async batch => {
				for (const { jobId, text } of batch) completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async batch => {
				for (const { jobId, text } of batch) completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"task",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async batch => {
				for (const { jobId, text } of batch) completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async batch => {
				for (const { jobId, text } of batch) completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("bounds owner-job reap while preserving late settlement", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"ignores abort",
			async () => {
				await release.promise;
				return "late result";
			},
			{ ownerId: "owner" },
		);

		const reap = await manager.cancelAndReapOwnerJobs("owner", Date.now());

		expect(reap.settled).toBe(false);
		expect(reap.pendingJobIds).toEqual([jobId]);
		expect(manager.getJob(jobId)?.status).toBe("cancelled");

		release.resolve();
		await reap.completion;
		expect(manager.getJob(jobId)?.resultText).toBe("late result");
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("queued jobs do not count toward the cap until markRunning", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queuedJobId = manager.register(
			"task",
			"queued",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return "queued done";
			},
			{ queued: true },
		);

		// Queued job holds no slot: another job registers fine at cap 1.
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		// Free the slot, then let the queued job start: it now occupies the slot.
		manager.cancel(runningJobId);
		gate.resolve();
		await started.promise;
		expect(() => manager.register("bash", "third", async () => "third")).toThrow(/Background job limit reached/);

		release.resolve();
		await manager.waitForAll();
		expect(manager.getJob(queuedJobId)?.status).toBe("completed");
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await waitForJobEviction(manager, jobId);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		let completedJobId = "";
		const completedDelivered = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async completions => {
				if (completions.some(completion => completion.jobId === completedJobId)) completedDelivered.resolve();
			},
		});

		completedJobId = manager.register("task", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		await completedDelivered.promise;
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Promise.all([waitForJobEviction(manager, completedJobId), waitForJobEviction(manager, runningJobId)]);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let failedJobId = "";
		let attempts = 0;
		const sentinelDelivered = Promise.withResolvers<void>();
		const firstAttempt = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async completions => {
				if (!completions.some(completion => completion.jobId === failedJobId)) {
					sentinelDelivered.resolve();
					return;
				}
				attempts += 1;
				firstAttempt.resolve();
				throw new Error("delivery failed");
			},
		});

		failedJobId = manager.register("task", "awaited-job", async () => "done");
		await manager.waitForAll();

		await firstAttempt.promise;
		while (!manager.hasPendingDeliveries()) await scheduler.yield();

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([failedJobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		manager.register("task", "sentinel-job", async () => "sentinel");
		await manager.waitForAll();
		await sentinelDelivered.promise;
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("dispose honors timeout when a cancelled job never settles", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		manager.register("bash", "ignores-abort", async () => {
			await Promise.withResolvers<never>().promise;
			return "unreachable";
		});

		const drained = await manager.dispose({ timeoutMs: 25 });

		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("starts queued deliveries while an earlier sink receipt is pending", async () => {
		const releaseDeliveries = Promise.withResolvers<void>();
		const bothStarted = Promise.withResolvers<void>();
		const started: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("Main", async jobId => {
			started.push(jobId);
			if (started.length === 2) bothStarted.resolve();
			await releaseDeliveries.promise;
		});

		const firstId = manager.register("task", "first", async () => "first result", { ownerId: "Main" });
		const secondId = manager.register("task", "second", async () => "second result", { ownerId: "Main" });
		await manager.waitForAll();

		await bothStarted.promise;
		expect(started).toEqual([firstId, secondId]);

		releaseDeliveries.resolve();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const mainDeliveryFinished = Promise.withResolvers<void>();
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
			mainDeliveryFinished.resolve();
		});
		manager.registerDeliverySink("3-AuthLoader", (jobId, text) => {
			subagentCompletions.push({ jobId, text });
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await mainDeliveryFinished.promise;
		await manager.dispose();
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
		});
		manager.registerDeliverySink("3-AuthLoader", async jobId => {
			notifyTargetDeliveryStarted();
			await targetDeliveryReleased;
			completions.push(jobId);
		});

		manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});

	test("routes owned deliveries to the owner's registered sink only", async () => {
		const mainDeliveries: string[] = [];
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async completions => {
				defaultDeliveries.push(...completions.map(completion => completion.jobId));
			},
		});
		manager.registerDeliverySink("Main", jobId => {
			mainDeliveries.push(jobId);
		});

		manager.register("bash", "owned", async () => "ok", { id: "owned-1", ownerId: "Main" });
		manager.register("bash", "unowned", async () => "ok", { id: "unowned-1" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(mainDeliveries).toEqual(["owned-1"]);
		expect(defaultDeliveries).toEqual(["unowned-1"]);
	});

	test("dead-letters an owned delivery when its owner has no live sink", async () => {
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async completions => {
				defaultDeliveries.push(...completions.map(completion => completion.jobId));
			},
		});
		const unregister = manager.registerDeliverySink("Sub", () => {});
		unregister();

		manager.register("bash", "orphan", async () => "orphan result", { id: "orphan-1", ownerId: "Sub" });
		await manager.waitForAll();
		const drained = await manager.drainDeliveries({ timeoutMs: 500 });

		// Dead-letter drops the delivery (drain settles) without misrouting it
		// into the default sink; the outcome stays readable on the job row.
		expect(drained).toBe(true);
		expect(defaultDeliveries).toEqual([]);
		expect(manager.getJob("orphan-1")?.resultText).toBe("orphan result");
	});

	test("waitForOwnerJobs settles cancelled jobs and skips suppressed ones on request", async () => {
		const manager = new AsyncJobManager({});
		manager.register(
			"bash",
			"hung",
			async ({ signal }) => {
				await new Promise<void>(resolve => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "stopped";
			},
			{ id: "hung-1", ownerId: "Sub" },
		);

		// Quiescence-barrier contract: a watched (suppressed) job can never
		// re-wake a run, so the filtered wait treats it as settled.
		manager.watchJobs(["hung-1"]);
		await expect(manager.waitForOwnerJobs("Sub", { excludeSuppressed: true })).resolves.toBe(true);

		// Teardown-reap contract: the unfiltered wait blocks until the
		// cancelled job's body actually finishes.
		const reap = manager.waitForOwnerJobs("Sub", { timeoutMs: 1_000 });
		manager.cancelAll({ ownerId: "Sub" });
		await expect(reap).resolves.toBe(true);
		expect(manager.getJob("hung-1")?.status).toBe("cancelled");
	});

	test("live same-batch sibling extends the settle hold past deliveryBatchMaxWaitMs", async () => {
		// Reproduces the user-visible bug: a task fan-out whose subagents run
		// longer than the settle cap delivered one completion per turn — each
		// finished task waited out the cap while siblings still ran, then
		// dispatched alone. A running job that shares the spawn batch with a
		// queued delivery and keeps reporting progress must extend the hold
		// until the whole batch settles.
		const dispatchBatches: string[][] = [];
		const manager = new AsyncJobManager({
			deliveryBatchMaxWaitMs: 300,
			onJobComplete: async batch => {
				dispatchBatches.push(batch.map(c => c.jobId));
			},
		});

		const releaseB = Promise.withResolvers<void>();
		const idA = manager.register("task", "a", async () => "a", { batchId: "fanout" });
		const idB = manager.register(
			"task",
			"b",
			async ({ reportProgress }) => {
				// Stay alive well past the cap while emitting progress, like a
				// long-running subagent streaming events.
				const heartbeat = setInterval(() => void reportProgress("working"), 75);
				try {
					await releaseB.promise;
				} finally {
					clearInterval(heartbeat);
				}
				return "b";
			},
			{ batchId: "fanout" },
		);

		// Well past the 300ms cap: without the batch hold A would have
		// dispatched alone by now.
		await Bun.sleep(1_000);
		expect(dispatchBatches).toHaveLength(0);

		releaseB.resolve();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(dispatchBatches).toHaveLength(1);
		expect(dispatchBatches[0]?.slice().sort()).toEqual([idA, idB].sort());
	});

	test("silent same-batch sibling counts as hung and stops extending the hold", async () => {
		const dispatchBatches: string[][] = [];
		const manager = new AsyncJobManager({
			deliveryBatchMaxWaitMs: 250,
			onJobComplete: async batch => {
				dispatchBatches.push(batch.map(c => c.jobId));
			},
		});

		const neverRelease = Promise.withResolvers<void>();
		const idA = manager.register("task", "a", async () => "a", { batchId: "fanout" });
		manager.register(
			"task",
			"b",
			async () => {
				await neverRelease.promise;
				return "b";
			},
			{ batchId: "fanout" },
		);

		// B shares the batch but never reports progress: once it has been
		// silent for the whole cap it must stop holding A's delivery hostage.
		await Bun.sleep(1_000);
		expect(dispatchBatches).toEqual([[idA]]);

		manager.cancelAll();
		neverRelease.resolve();
		await manager.waitForAll();
	});

	test("active job outside the batch cannot extend the hold past the cap", async () => {
		// A perpetually-chatty job with no batchId (e.g. a dev server bash
		// job streaming logs) must not block batch deliveries forever — only
		// same-batch siblings earn the extended hold.
		const dispatchBatches: string[][] = [];
		const manager = new AsyncJobManager({
			deliveryBatchMaxWaitMs: 250,
			onJobComplete: async batch => {
				dispatchBatches.push(batch.map(c => c.jobId));
			},
		});

		const releaseServer = Promise.withResolvers<void>();
		const idA = manager.register("task", "a", async () => "a", { batchId: "fanout" });
		manager.register("bash", "dev server", async ({ reportProgress }) => {
			const heartbeat = setInterval(() => void reportProgress("listening"), 50);
			try {
				await releaseServer.promise;
			} finally {
				clearInterval(heartbeat);
			}
			return "server";
		});

		await Bun.sleep(1_000);
		expect(dispatchBatches).toEqual([[idA]]);

		manager.cancelAll();
		releaseServer.resolve();
		await manager.waitForAll();
	});

	test("onChange fires on register and terminal transition even with no progress", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		let changes = 0;
		const unsubscribe = manager.onChange(() => {
			changes++;
		});

		// A job that never calls reportProgress (mirrors the slash-command-spawned
		// knowledge pass): the panel must still learn it started, then finished.
		manager.register("task", "KnowledgeCompact", async () => "done");
		// Registration notifies synchronously so the panel kicks immediately.
		expect(changes).toBe(1);

		await manager.waitForAll();
		// The terminal transition (completed) notifies too.
		expect(changes).toBe(2);

		unsubscribe();
		manager.register("task", "Other", async () => "done");
		expect(changes).toBe(2);
	});
});
