import { beforeAll, describe, expect, it, type Mock } from "bun:test";
import { isSettled } from "@oh-my-pi/pi-tui";
import type { WorkingSpec } from "../../../src/ui/dock";
import { createTuiFindRefusalUi } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/find-refusal";
import { initTheme } from "../../../src/ui/theme/service";
import { createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";

/**
 * Regression: /find-refusal left a "Working…" spinner running forever after the
 * run finished. `working()` puts a maintenance working row in the status slot,
 * so `done()` has to take that row down again (a message reset alone would not)
 * and settle the live progress panel.
 */
function createContext() {
	const ctx = createInteractiveModeContext({});
	const showWorking = ctx.showWorking as unknown as Mock<(kind: string, spec: WorkingSpec) => void>;
	return { ctx, showWorking };
}

describe("createTuiFindRefusalUi working-row lifecycle", () => {
	beforeAll(() => {
		initTheme();
	});

	it("done() takes down the maintenance row that working() put up", () => {
		const { ctx, showWorking } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.working("Analyzing the refusal…");
		expect(ctx.working).toBe("maintenance");
		const spec = showWorking.mock.calls.at(-1)?.[1];
		expect(typeof spec?.label === "function" ? spec.label() : spec?.label).toBe("Analyzing the refusal…");

		ui.done();
		expect(ctx.working).toBeUndefined();
	});

	it("working() shows the row again per phase, restarting its clock", () => {
		const { ctx, showWorking } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.working("Analyzing the refusal (round 1)…");
		ui.working("Re-testing with the main model (round 1)…");

		expect(showWorking).toHaveBeenCalledTimes(2);
		const spec = showWorking.mock.calls.at(-1)?.[1];
		expect(typeof spec?.label === "function" ? spec.label() : spec?.label).toBe(
			"Re-testing with the main model (round 1)…",
		);
	});

	it("working() with no message leaves the row alone", () => {
		const { ctx, showWorking } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.working();
		ui.working("");

		expect(showWorking).not.toHaveBeenCalled();
		expect(ctx.working).toBeUndefined();
	});

	it("step() does not take the row down (the run is ongoing), so done() is what tears it down", () => {
		const { ctx } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.working("Re-testing with the main model…");
		expect(ctx.working).toBe("maintenance");

		// A progress line mid-run must not kill the spinner.
		ui.step("Proposed 1 pattern");
		expect(ctx.working).toBe("maintenance");

		ui.done();
		expect(ctx.working).toBeUndefined();
	});

	it("keeps the panel live while the run goes on and settles it in done()", () => {
		const { ctx } = createContext();
		const ui = createTuiFindRefusalUi(ctx);
		const [panel] = ctx.shell.transcript.blocks();

		expect(panel).toBeDefined();
		expect(isSettled(panel!.node)).toBe(false);
		ui.step("Proposed 1 pattern");
		expect(isSettled(panel!.node)).toBe(false);

		ui.done();
		expect(isSettled(panel!.node)).toBe(true);
	});

	it("step() indents every line of a multi-line block (the printed YAML)", () => {
		const { ctx } = createContext();
		const ui = createTuiFindRefusalUi(ctx);

		ui.step("- type: regex\n  content: Alpha\n  mode: obfuscate");

		const rendered = renderTranscript(ctx, 80).map(line => line.trimEnd());
		// The panel pads 1 column; step lines are indented 2 more.
		expect(rendered).toContain(" Find refusal");
		expect(rendered).toContain("   - type: regex");
		expect(rendered).toContain("     content: Alpha");
		expect(rendered).toContain("     mode: obfuscate");
	});
});
