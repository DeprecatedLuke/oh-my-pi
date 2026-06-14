import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createTuiFixRefusalUi } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/fix-refusal";

/**
 * Regression: /fix-refusal left a "Working…" spinner running forever after the
 * run finished. `working()` starts the loader via `ensureLoadingAnimation()`,
 * but the old `done()` only called `setWorkingMessage(undefined)` — which (in
 * the real InteractiveMode) merely RELABELS a live loader to the default
 * "Working…" text and never stops it. The fix adds `stopLoadingAnimation()` to
 * the context and calls it from `done()`.
 *
 * This models that exact invariant so a future regression (dropping the
 * stop call, or `done()` going back to message-clear only) fails here.
 */
function createContext() {
	// Faithful loader state machine: only ensure/stop toggle `loaderActive`;
	// setWorkingMessage(undefined) just resets the label, matching
	// InteractiveMode.setWorkingMessage (relabels to default, keeps spinning).
	const state = { loaderActive: false, message: undefined as string | undefined };
	const ctx = {
		ui: { requestRender: () => {} },
		present: () => {},
		setWorkingMessage: (message?: string) => {
			state.message = message ?? "Working…";
		},
		ensureLoadingAnimation: () => {
			state.loaderActive = true;
		},
		stopLoadingAnimation: () => {
			state.loaderActive = false;
		},
	} as unknown as InteractiveModeContext;
	return { ctx, state };
}

describe("createTuiFixRefusalUi loader lifecycle", () => {
	beforeAll(() => {
		initTheme();
	});

	it("done() stops the loading animation that working() started", () => {
		const { ctx, state } = createContext();
		const ui = createTuiFixRefusalUi(ctx);

		ui.working("Analyzing the refusal…");
		expect(state.loaderActive).toBe(true);

		ui.done();
		expect(state.loaderActive).toBe(false);
	});

	it("step() does not stop the loader (only relabels), so done() is what tears it down", () => {
		const { ctx, state } = createContext();
		const ui = createTuiFixRefusalUi(ctx);

		ui.working("Re-testing with the main model…");
		expect(state.loaderActive).toBe(true);

		// A progress line mid-run must not kill the spinner — the run is ongoing.
		ui.step("Proposed 1 pattern");
		expect(state.loaderActive).toBe(true);

		ui.done();
		expect(state.loaderActive).toBe(false);
	});
});
