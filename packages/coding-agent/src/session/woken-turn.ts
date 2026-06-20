import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async/job-manager";

export interface WokenTurnJobOptions {
	/** The session's async job manager (the shared, Main-owned instance for subagents). */
	manager: AsyncJobManager | undefined;
	/** Registry id of the agent running the turn — used as the job id (the Background Jobs panel row label). */
	agentId: string | undefined;
	/**
	 * Owner the job is filed under — the agent whose Background Jobs panel,
	 * pending-async-work, and lifecycle cancellation it belongs to. MUST be the
	 * panel that should surface the woken turn (the top-level `Main` session), NOT
	 * the woken subagent, or the owner-scoped panel filter drops it.
	 */
	ownerId: string;
	/** `"sub"` agents register a job; the main agent never does (its wakes deliver to itself). */
	agentKind: "main" | "sub";
	/**
	 * Drives the actual turn. MUST resolve when the turn ends (so the job stays
	 * "running" for the turn's lifetime) and MUST NOT reject — it owns its own
	 * error handling and in-flight bookkeeping.
	 */
	runTurn: () => Promise<void>;
	/** Completion text delivered to the owner when the turn is tracked as a job. */
	summarize: (agentId: string) => string;
}

/**
 * Run a subagent's woken/revived turn, tracking it as a background job when
 * possible.
 *
 * A subagent that finished its original `task` spawn turn is adopted (idle, then
 * parked) and can run later turns when a peer's IRC message, a stranded-aside
 * resume, or a revive wakes it. Those later turns flip the agent's registry
 * status to `running` (so the Agent Hub shows it) but the original spawn job has
 * already completed — nothing tracks the new turn. Wrapping it in its own job
 * makes the woken turn (a) appear in the anchored Background Jobs panel, (b) keep
 * the owning session's pending-async-work true while it runs, and (c) deliver a
 * completion follow-up that wakes the owner once the turn ends — otherwise the
 * owner never learns the woken turn finished.
 *
 * Degrades safely to an untracked turn — the turn still runs — when there is no
 * manager, for the main agent (its own wakes are the delivery target, not
 * background work), when the job table is at capacity, or if registration races
 * a full table. A woken turn MUST never be dropped because no job slot was free.
 */
export function runWokenTurnTracked(opts: WokenTurnJobOptions): void {
	const { manager, agentId, ownerId, agentKind, runTurn, summarize } = opts;
	if (manager && agentId && agentKind === "sub" && !manager.atCapacity) {
		try {
			manager.register(
				"task",
				agentId,
				async ({ markRunning }) => {
					markRunning();
					await runTurn();
					return summarize(agentId);
				},
				{ id: agentId, ownerId },
			);
			return;
		} catch (error) {
			logger.debug("Woken-turn job registration failed; running untracked", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	void runTurn();
}
