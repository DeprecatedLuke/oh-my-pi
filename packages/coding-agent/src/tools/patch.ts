import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import {
	applyNativePatch,
	defaultPatchStore,
	dropNativePatch,
	formatRepoLabel,
	listNativePatches,
	type NativePatchManifest,
	resolveNativePatchStore,
	writeNativePatchMessage,
} from "../patches";
import patchDescription from "../prompts/tools/native-patch.md" with { type: "text" };
import { generateCommitMessage } from "../utils/commit-message-generator";
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const patchSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("list"),
		list_dropped: z.boolean().optional().describe("include patches already marked dropped"),
	}),
	z.object({
		op: z.literal("apply"),
		patch: z.string().describe("patch id to apply"),
		message: z.string().optional().describe("commit message to persist before applying a Git patch"),
	}),
	z.object({
		op: z.literal("reapply"),
		patch: z.string().describe("conflicted patch id to finalize after marker resolution"),
		message: z.string().optional().describe("commit message to persist before reapplying a Git patch"),
	}),
	z.object({
		op: z.literal("drop"),
		patch: z.string().describe("patch id to mark dropped"),
	}),
]);

export type PatchToolParams = z.infer<typeof patchSchema>;

export interface PatchToolDetails {
	op: PatchToolParams["op"];
	patch?: string;
	manifest?: NativePatchManifest;
	patches?: NativePatchManifest[];
	applied?: boolean;
	message?: string;
	meta?: OutputMeta;
}

export class PatchTool implements AgentTool<typeof patchSchema, PatchToolDetails> {
	readonly name = "patch";
	readonly approval = (args: unknown) => {
		const op = (args as Partial<PatchToolParams>).op;
		return op === "list" ? "read" : "write";
	};
	readonly label = "Patch";
	readonly summary = "List, apply, reapply, or drop durable task patches";
	readonly description: string;
	readonly parameters = patchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<PatchToolParams>) => {
		if (args.op === "list") return "listing patches";
		if (args.op === "drop") return args.patch ? `dropping patch ${args.patch}` : "dropping patch";
		if (args.op === "apply") return args.patch ? `applying patch ${args.patch}` : "applying patch";
		if (args.op === "reapply") return args.patch ? `reapplying patch ${args.patch}` : "reapplying patch";
		return "patch";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(patchDescription);
	}

	static createIf(session: ToolSession): PatchTool | null {
		if ((session.taskDepth ?? 0) !== 0) return null;
		return new PatchTool(session);
	}

	async execute(
		_toolCallId: string,
		params: PatchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<PatchToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<PatchToolDetails>> {
		return untilAborted(signal, async () => {
			const store = defaultPatchStore(this.session.cwd);
			if (params.op === "list") {
				const patches = await listNativePatches(store, {
					listDropped: params.list_dropped ?? false,
					cwd: this.session.cwd,
				});
				const details: PatchToolDetails = { op: "list", patches };
				return toolResult<PatchToolDetails>(details).text(formatPatchList(this.session.cwd, patches)).done();
			}

			const patchId = params.patch.trim();
			if (patchId.length === 0) throw new ToolError("patch id is required.");
			const idStore = await resolveNativePatchStore(this.session.cwd, patchId);

			if (params.op === "drop") {
				const manifest = await dropNativePatch(idStore, patchId);
				const details: PatchToolDetails = { op: "drop", patch: patchId, manifest };
				return toolResult<PatchToolDetails>(details)
					.text(`Dropped ${formatPatchLabel(this.session.cwd, manifest)}.`)
					.done();
			}

			if (params.op === "apply" || params.op === "reapply") {
				if (params.message !== undefined) {
					const message = params.message.trim();
					if (!message) throw new ToolError("message must be non-empty when provided.");
					await writeNativePatchMessage(idStore, patchId, message);
				}
				try {
					const applied = await applyNativePatch(idStore, patchId, {
						cwd: this.session.cwd,
						signal,
						generateMessage: async manifest => {
							if (!this.session.modelRegistry) return null;
							return generateCommitMessage(
								formatManifestForCommitMessage(manifest),
								this.session.modelRegistry,
								this.session.settings,
								this.session.getSessionId?.() ?? undefined,
							);
						},
					});
					const details: PatchToolDetails = {
						op: params.op,
						patch: patchId,
						manifest: applied.manifest,
						applied: applied.applied,
						message: applied.manifest.message,
					};
					return toolResult<PatchToolDetails>(details)
						.text(formatPatchApplyResult(this.session.cwd, applied))
						.done();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (/(message|generate|generation|unavailable)/i.test(message) && !params.message) {
						throw new ToolError(
							`${message}\nPopulate \`message:\` and retry \`patch\` with \`op: "${params.op}"\`.`,
						);
					}
					throw new ToolError(message);
				}
			}

			throw new ToolError(`Unsupported patch op: ${(params as { op?: string }).op ?? "(missing)"}`);
		});
	}
}

function formatPatchList(cwd: string, patches: readonly NativePatchManifest[]): string {
	if (patches.length === 0) return "No pending patches.";
	return patches.map(patch => formatPatchSummary(cwd, patch)).join("\n");
}

function formatPatchSummary(cwd: string, patch: NativePatchManifest): string {
	const parts = [`${formatPatchLabel(cwd, patch)}: ${patch.status}`];
	const description = firstLine(patch.description);
	if (description) parts.push(description);
	if (patch.taskId) parts.push(`task ${patch.taskId}`);
	const files = Array.isArray(patch.files) ? patch.files.length : 0;
	parts.push(`${files} ${files === 1 ? "file" : "files"}`);
	const conflicts = Array.isArray(patch.conflicts) ? patch.conflicts.length : 0;
	if (conflicts > 0) parts.push(`${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}`);
	const subject = firstLine(patch.message);
	if (subject) parts.push(`message: ${subject}`);
	return parts.join(" — ");
}

function formatPatchApplyResult(
	cwd: string,
	result: { manifest: NativePatchManifest; applied: boolean; committed?: boolean; commit?: string; message?: string },
): string {
	const label = formatPatchLabel(cwd, result.manifest);
	if (!result.applied) {
		const conflicts = result.manifest.conflicts ?? [];
		const markered = conflicts.filter(c => c.markersWritten);
		const plain = conflicts.filter(c => !c.markersWritten);
		const lines: string[] = [`patch apply failed:`, `patch://${result.manifest.id}:`];
		if (markered.length > 0) {
			lines.push(`  conflict markers written to ${markered.length} ${markered.length === 1 ? "file" : "files"}:`);
			for (const conflict of markered) lines.push(`    - ${conflict.path}`);
			lines.push(
				"  read each file to register conflict:// IDs, resolve with write conflict://<N>, then run patch reapply",
			);
		}
		if (plain.length > 0) {
			lines.push("  unresolvable conflicts (edit patch://<id>/<file> or drop the patch):");
			for (const conflict of plain) lines.push(`    - ${conflict.path}: ${conflict.reason}`);
		}
		if (conflicts.length === 0) lines.push("  patch did not apply cleanly");
		return lines.join("\n");
	}
	const subject = firstLine(result.message ?? result.manifest.message);
	const commit = result.commit
		? ` and committed ${result.commit.slice(0, 12)}`
		: result.committed
			? " and committed"
			: "";
	const noCommit =
		result.committed === false && result.manifest.repoRoot ? " (already landed; no commit created)" : "";
	return subject ? `${label}: applied${commit}${noCommit} — ${subject}` : `${label}: applied${commit}${noCommit}.`;
}

function formatPatchLabel(cwd: string, patch: NativePatchManifest): string {
	const repoPath = patch.repoRoot ?? patch.targetRoot ?? cwd;
	return `${formatRepoLabel(cwd, repoPath)}/${patch.id}`;
}

function formatManifestForCommitMessage(manifest: NativePatchManifest): string {
	const lines = [
		`Native patch ${manifest.id}`,
		manifest.description ? `Description: ${manifest.description}` : undefined,
		manifest.taskId ? `Task: ${manifest.taskId}` : undefined,
		"Files:",
		...manifest.files.map(file => `- ${file.op} ${file.path}`),
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

function firstLine(value: string | undefined): string | undefined {
	const line = value?.trim().split("\n")[0]?.trim();
	return line || undefined;
}
