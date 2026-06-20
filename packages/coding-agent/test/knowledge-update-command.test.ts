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

function makeRuntime(results?: { update?: StartResult; compact?: StartResult }) {
	const outputs: string[] = [];
	const updateCalls: KnowledgeOpts[] = [];
	const compactCalls: KnowledgeOpts[] = [];
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
			saveKnowledge: async (): Promise<{ committed: boolean; sha?: string }> => ({ committed: false }),
		},
		output: (text: string) => {
			outputs.push(text);
		},
	};
	return { runtime, outputs, updateCalls, compactCalls };
}

async function run(args: string, results?: { update?: StartResult; compact?: StartResult }) {
	const cmd = knowledgeCommand();
	const ctx = makeRuntime(results);
	const consumed = await cmd.handle?.(
		{ name: "knowledge", args, text: `/knowledge ${args}` } as never,
		ctx.runtime as never,
	);
	return { consumed, ...ctx };
}

describe("/knowledge update slash command", () => {
	test("advertises update between save and compact", () => {
		expect(knowledgeCommand().subcommands?.map(s => s.name)).toEqual(["save", "update", "compact"]);
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
