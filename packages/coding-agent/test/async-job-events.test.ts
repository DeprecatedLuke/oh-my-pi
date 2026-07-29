import { describe, expect, test } from "bun:test";
import { ASYNC_JOBS_CHANGED_CHANNEL, AsyncJobManager, forwardAsyncJobChanges } from "@oh-my-pi/pi-coding-agent/async";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

describe("forwardAsyncJobChanges", () => {
	test("forwards total bash/task counts through terminal and cancellation, then unsubscribes", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
			retentionMs: 0,
		});
		const eventBus = new EventBus();
		const events: unknown[] = [];
		const stopListening = eventBus.on(ASYNC_JOBS_CHANGED_CHANNEL, event => {
			events.push(event);
		});
		const unsubscribe = forwardAsyncJobChanges(manager, eventBus);

		const bashGate = Promise.withResolvers<string>();
		const bashJobId = manager.register("bash", "shell work", async () => bashGate.promise);
		const bashJob = manager.getJob(bashJobId);
		expect(bashJob).toBeDefined();
		expect(events).toEqual([{ running: 1 }]);

		const taskJobId = manager.register(
			"task",
			"queued task",
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				return "cancelled";
			},
			{ queued: true },
		);
		const taskJob = manager.getJob(taskJobId);
		expect(taskJob).toBeDefined();
		expect(events).toEqual([{ running: 1 }, { running: 2 }]);

		bashGate.resolve("shell complete");
		await bashJob!.promise;
		expect(events).toEqual([{ running: 1 }, { running: 2 }, { running: 1 }]);

		expect(manager.cancel(taskJobId)).toBe(true);
		expect(events).toEqual([{ running: 1 }, { running: 2 }, { running: 1 }, { running: 0 }]);
		await taskJob!.promise;
		expect(events).toEqual([{ running: 1 }, { running: 2 }, { running: 1 }, { running: 0 }, { running: 0 }]);

		unsubscribe();
		const lateGate = Promise.withResolvers<string>();
		const lateJobId = manager.register("bash", "after unsubscribe", async () => lateGate.promise);
		const lateJob = manager.getJob(lateJobId);
		expect(lateJob).toBeDefined();
		expect(events).toHaveLength(5);
		lateGate.resolve("late complete");
		await lateJob!.promise;
		expect(events).toHaveLength(5);

		stopListening();
	});
});
