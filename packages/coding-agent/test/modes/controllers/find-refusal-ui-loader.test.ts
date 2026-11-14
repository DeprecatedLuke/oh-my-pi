import { beforeAll, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createTuiFindRefusalUi } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/find-refusal";

/**
 * Regression: /find-refusal left a "Working…" spinner running forever after the
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
	const state = { loaderActive: false, message: undefined as string | undefined, presented: [] as Component[] };
	const ctx = {
		ui: { requestRender: () => {} },
		present: (items: Component[]) => {
			state.presented.push(...items);
		},
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

describe("createTuiFindRefusalUi loader lifecycle", () => {
	beforeAll(() => {
		initTheme();
	});

	it("done() stops the loading animation that working() started", () => {
		const { ctx, state } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.working("Analyzing the refusal…");
		expect(state.loaderActive).toBe(true);

		ui.done();
		expect(state.loaderActive).toBe(false);
	});

	it("step() does not stop the loader (only relabels), so done() is what tears it down", () => {
		const { ctx, state } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.working("Re-testing with the main model…");
		expect(state.loaderActive).toBe(true);

		// A progress line mid-run must not kill the spinner — the run is ongoing.
		ui.step("Proposed 1 pattern");
		expect(state.loaderActive).toBe(true);

		ui.done();
		expect(state.loaderActive).toBe(false);
	});

	it("step() indents every line of a multi-line block (the printed YAML)", () => {
		const { ctx, state } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.step("- type: regex\n  content: Alpha\n  mode: obfuscate");

		const panel = state.presented[1];
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR color codes
		const rendered = panel.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
		// Text pads 1 column; step lines are indented 2 more.
		expect(rendered).toContain("   - type: regex");
		expect(rendered).toContain("     content: Alpha");
		expect(rendered).toContain("     mode: obfuscate");
	});
});
