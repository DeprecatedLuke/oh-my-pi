import type { EventBus } from "../utils/event-bus";
import type { AsyncJobManager } from "./job-manager";

/** EventBus channel carrying the authoritative number of unfinished background jobs. */
export const ASYNC_JOBS_CHANGED_CHANNEL = "async:jobs:changed";

export interface AsyncJobsChangedPayload {
	running: number;
}

/** Forward process-global background-job changes to extensions bound to the root session. */
export function forwardAsyncJobChanges(jobManager: AsyncJobManager, eventBus: EventBus): () => void {
	return jobManager.onChange(() => {
		eventBus.emit(ASYNC_JOBS_CHANGED_CHANNEL, {
			running: jobManager.getRunningJobs().length,
		} satisfies AsyncJobsChangedPayload);
	});
}
