/**
 * Parallel execution with concurrency control.
 */

import { MAX_CONCURRENCY } from "./types";

/**
 * Execute items with a concurrency limit using a worker pool pattern.
 * Results are returned in the same order as input items.
 * Fails fast on first error - does not wait for other workers to complete.
 *
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to execute for each item
 * @param signal - Optional abort signal to stop scheduling work
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const limit = Math.max(1, Math.min(concurrency, items.length, MAX_CONCURRENCY));
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	// Create internal abort controller to cancel workers on any rejection
	const abortController = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	// Promise that rejects on first error - used to fail fast
	let rejectFirst: (error: unknown) => void;
	const firstErrorPromise = new Promise<never>((_, reject) => {
		rejectFirst = reject;
	});

	const worker = async (): Promise<void> => {
		while (true) {
			workerSignal.throwIfAborted();
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index], index);
			} catch (error) {
				abortController.abort();
				rejectFirst(error);
				throw error;
			}
		}
	};

	// Create worker pool
	const workers = Array(limit)
		.fill(null)
		.map(() => worker());
	await Promise.race([Promise.all(workers), firstErrorPromise]);

	// Check external abort
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
		throw reason;
	}

	return results;
}
