import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearFixRefusalState,
	type FixRefusalState,
	loadFixRefusalState,
	saveFixRefusalState,
} from "@oh-my-pi/pi-coding-agent/secrets/fix-refusal-state";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "fix-refusal-state-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const sample = (overrides: Partial<FixRefusalState> = {}): FixRefusalState => ({
	sessionId: "sess-1",
	entries: [{ type: "regex", content: "SecretCorp", mode: "obfuscate" }],
	refusalText: "Refusal (cyber): blocked",
	updatedAt: Date.now(),
	...overrides,
});

describe("fix-refusal-state", () => {
	it("round-trips save -> load", async () => {
		await saveFixRefusalState(dir, sample());
		const loaded = await loadFixRefusalState(dir);
		expect(loaded?.sessionId).toBe("sess-1");
		expect(loaded?.entries.map(e => e.content)).toEqual(["SecretCorp"]);
	});
	it("returns null after clear", async () => {
		await saveFixRefusalState(dir, sample());
		await clearFixRefusalState(dir);
		expect(await loadFixRefusalState(dir)).toBeNull();
	});
	it("clear is a no-op when no state exists", async () => {
		await clearFixRefusalState(dir);
		expect(await loadFixRefusalState(dir)).toBeNull();
	});
	it("ignores stale state past the TTL", async () => {
		await saveFixRefusalState(dir, sample({ updatedAt: Date.now() - 25 * 60 * 60 * 1000 }));
		expect(await loadFixRefusalState(dir)).toBeNull();
	});
	it("returns null for a corrupt or invalid state file", async () => {
		await fs.writeFile(path.join(dir, "fix-refusal-state.json"), "{ not valid json");
		expect(await loadFixRefusalState(dir)).toBeNull();
	});
});
