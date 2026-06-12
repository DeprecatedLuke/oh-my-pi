/**
 * Three-way (and two-way) text merge helpers that produce diff3-style
 * conflict markers compatible with the `conflict://` resolution system.
 *
 * Materializing markers in the target file (instead of refusing to apply
 * and asking the agent to edit `patch://<id>/<file>`) lets agents resolve
 * patch conflicts through the same channel they already use for git
 * merge conflicts: read the file, see registered `conflict://<N>` IDs,
 * write resolved content with `conflict://<N>`, then re-run `patch apply`.
 *
 * Backed by `git merge-file --diff3 -p` because:
 *   1. Its output uses the exact `<<<<<<<` / `|||||||` / `=======` /
 *      `>>>>>>>` marker shape `conflict-detect.ts`'s scanner expects.
 *   2. It operates on three loose files — no repo required.
 *   3. Exit code = number of conflict regions (`0` = clean merge), so
 *      callers can branch cheaply on success/failure.
 *   4. `git` is already a hard dependency of the native-patch pipeline.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Three text inputs labeled "patched" (the patch's intended content),
 * "baseline" (what the patch expected to find on disk), and "current"
 * (what is actually on disk now). Labels surface in the conflict markers
 * as `<<<<<<< patched` / `||||||| baseline` / `>>>>>>> current` so the
 * agent's `conflict://` resolver can describe each side meaningfully.
 */
export interface Merge3WayInput {
	patched: string;
	baseline: string;
	current: string;
	patchedLabel?: string;
	baselineLabel?: string;
	currentLabel?: string;
}

export interface Merge3WayResult {
	/** Merged text with `<<<<<<< / ||||||| / ======= / >>>>>>>` blocks for unresolved regions. */
	merged: string;
	/** Number of diff3 conflict regions in `merged`. `0` means a clean merge with no markers. */
	conflictCount: number;
}

const DEFAULT_PATCHED_LABEL = "patched";
const DEFAULT_BASELINE_LABEL = "baseline";
const DEFAULT_CURRENT_LABEL = "current";

/**
 * Run a diff3 three-way merge via `git merge-file --diff3 -p`. The three
 * inputs are written to a temp directory, merged, and the result returned
 * as text. The temp directory is always removed before the function returns.
 *
 * `conflictCount` is the literal exit code of `git merge-file`: `0` when
 * the merge was clean (no markers in `merged`), `N > 0` for `N` conflict
 * regions. A negative or unexpected exit raises an error — callers should
 * fall back to a plain "this file conflicts; resolve manually" path.
 */
export async function merge3Way(input: Merge3WayInput): Promise<Merge3WayResult> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-merge-"));
	try {
		const oursPath = path.join(dir, "ours");
		const basePath = path.join(dir, "base");
		const theirsPath = path.join(dir, "theirs");
		await Promise.all([
			Bun.write(oursPath, input.patched),
			Bun.write(basePath, input.baseline),
			Bun.write(theirsPath, input.current),
		]);
		const proc = Bun.spawn(
			[
				"git",
				"merge-file",
				"--diff3",
				"-p",
				"-L",
				input.patchedLabel ?? DEFAULT_PATCHED_LABEL,
				"-L",
				input.baselineLabel ?? DEFAULT_BASELINE_LABEL,
				"-L",
				input.currentLabel ?? DEFAULT_CURRENT_LABEL,
				oursPath,
				basePath,
				theirsPath,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderrText, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// `git merge-file` returns negative on internal error; conflict counts
		// are non-negative. Treat anything else as a hard failure so callers
		// can fall back to marking a plain (markerless) conflict.
		if (typeof exitCode !== "number" || exitCode < 0) {
			throw new Error(`git merge-file failed (exit=${exitCode}): ${stderrText.trim() || "unknown error"}`);
		}
		return { merged: stdout, conflictCount: exitCode };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/**
 * Two-way merge for "patch wants to add a file but one already exists".
 * Modeled as a three-way merge with an empty base — diff3 collapses the
 * empty base section and emits a normal `<<<<<<<` / `=======` / `>>>>>>>`
 * conflict region. Same marker shape, same `conflict://` resolution path.
 */
export async function merge2WayAddConflict(input: {
	patched: string;
	current: string;
	patchedLabel?: string;
	currentLabel?: string;
}): Promise<Merge3WayResult> {
	return merge3Way({
		patched: input.patched,
		baseline: "",
		current: input.current,
		patchedLabel: input.patchedLabel,
		currentLabel: input.currentLabel,
	});
}

/**
 * Reject inputs the diff3 merger cannot represent meaningfully:
 *   - NUL byte: binary content, line-oriented merge would corrupt it.
 *   - Excessively long single line: pathological inputs that would
 *     produce unhelpful giant marker blocks.
 *
 * Callers should fall back to "plain (markerless) conflict" when this
 * returns `false`.
 */
export function canMergeAsText(content: Uint8Array): boolean {
	const MAX_SINGLE_LINE = 1_000_000;
	let lineLen = 0;
	for (let i = 0; i < content.length; i++) {
		const byte = content[i];
		if (byte === 0) return false;
		if (byte === 0x0a) {
			lineLen = 0;
			continue;
		}
		lineLen += 1;
		if (lineLen > MAX_SINGLE_LINE) return false;
	}
	return true;
}
