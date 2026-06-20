import { describe, expect, test } from "bun:test";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

interface KnowledgeOpts {
	sourceTitle?: string;
	focus?: string;
	goal?: string;
}

type StartResult = { started: boolean; jobId?: string; reason?: string };

function knowledgeCommand() {
	const cmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "knowledge");
	if (!cmd?.handle) throw new Error("knowledge command (with handle) not found");
	return cmd;
}

function makeRuntime(results?: { update?: StartResult; compact?: StartResult; build?: StartResult }) {
	const outputs: string[] = [];
	const updateCalls: KnowledgeOpts[] = [];
	const compactCalls: KnowledgeOpts[] = [];
	const buildCalls: KnowledgeOpts[] = [];
	const runtime = {
		session: {
			updateKnowledge: (opts?: KnowledgeOpts): StartResult => {
				updateCalls.push(opts ?? {});
				return results?.update ?? { started: true, jobId: "KnowledgeUpdate" };
			},
			compactKnowledge: (opts?: KnowledgeOpts): StartResult => {
				compactCalls.push(opts ?? {});
				return results?.compact ?? { started: true, jobId: "KnowledgeCompact" };
			},
			buildKnowledge: (opts?: KnowledgeOpts): StartResult => {
				buildCalls.push(opts ?? {});
				return results?.build ?? { started: true, jobId: "KnowledgeBuild" };
			},
			saveKnowledge: async (): Promise<{ committed: boolean; sha?: string }> => ({ committed: false }),
		},
		output: (text: string) => {
			outputs.push(text);
		},
	};
	return { runtime, outputs, updateCalls, compactCalls, buildCalls };
}

async function run(args: string, results?: { update?: StartResult; compact?: StartResult; build?: StartResult }) {
	const cmd = knowledgeCommand();
	const ctx = makeRuntime(results);
	const consumed = await cmd.handle?.(
		{ name: "knowledge", args, text: `/knowledge ${args}` } as never,
		ctx.runtime as never,
	);
	return { consumed, ...ctx };
}

describe("/knowledge update slash command", () => {
	test("advertises save, build, update, compact in order", () => {
		expect(knowledgeCommand().subcommands?.map(s => s.name)).toEqual(["save", "build", "update", "compact"]);
	});

	test("routes `update <focus>` to updateKnowledge with focus and a labeled source", async () => {
		const { consumed, outputs, updateCalls } = await run("update testing notes");
		expect(consumed).toEqual({ consumed: true });
		expect(updateCalls).toEqual([{ sourceTitle: "/knowledge update testing notes", focus: "testing notes" }]);
		expect(outputs).toEqual(["Knowledge update started in the background (job KnowledgeUpdate)."]);
	});

	test("routes bare `update` with no focus", async () => {
		const { updateCalls, outputs } = await run("update");
		expect(updateCalls).toEqual([{ sourceTitle: "/knowledge update", focus: undefined }]);
		expect(outputs[0]).toContain("Knowledge update started");
	});

	test("surfaces the reason when the update cannot start", async () => {
		const { outputs } = await run("update", { update: { started: false, reason: "No model selected" } });
		expect(outputs).toEqual(["Knowledge update unavailable: No model selected."]);
	});

	test("still routes `compact` to compactKnowledge without update interference", async () => {
		const { compactCalls, updateCalls, outputs } = await run("compact stale docs");
		expect(updateCalls).toEqual([]);
		expect(compactCalls).toEqual([{ sourceTitle: "/knowledge compact stale docs", goal: "stale docs" }]);
		expect(outputs[0]).toBe("Knowledge compaction started in the background (job KnowledgeCompact).");
	});
});

describe("/knowledge build slash command", () => {
	test("routes `build <focus>` to buildKnowledge with focus and a labeled source", async () => {
		const { consumed, outputs, buildCalls } = await run("build auth flow");
		expect(consumed).toEqual({ consumed: true });
		expect(buildCalls).toEqual([{ sourceTitle: "/knowledge build auth flow", focus: "auth flow" }]);
		expect(outputs).toEqual(["Knowledge build started in the background (job KnowledgeBuild)."]);
	});

	test("routes bare `build` with no focus", async () => {
		const { buildCalls, outputs } = await run("build");
		expect(buildCalls).toEqual([{ sourceTitle: "/knowledge build", focus: undefined }]);
		expect(outputs[0]).toContain("Knowledge build started");
	});

	test("surfaces the reason when the build cannot start", async () => {
		const { outputs } = await run("build", { build: { started: false, reason: "No model selected" } });
		expect(outputs).toEqual(["Knowledge build unavailable: No model selected."]);
	});

	test("build does not interfere with update/compact", async () => {
		const { updateCalls, compactCalls } = await run("build x");
		expect(updateCalls).toEqual([]);
		expect(compactCalls).toEqual([]);
	});
});
