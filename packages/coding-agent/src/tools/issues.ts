/**
 * `issues` tool — add, edit, archive, unarchive, and list project-local
 * issues persisted under `<cwd>/.omp/issues/`. URLs (`issues://`) cover the
 * read side; this tool owns the write side so id allocation, slug
 * derivation, and archive moves stay in one place.
 *
 * When the reviewer subagent calls `op: add`, the subprocess tool registry
 * extracts each event into the parent's findings stream so the parent UI
 * can render the issues filed by a review without bespoke wiring per
 * caller.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { AddIssueInput, IssueRecord, IssueSeverity, IssueStatus, IssueSummary } from "../issues";
import { addIssue, archiveIssue, listIssues, normalizeCategory, renderIssueListing, unarchiveIssue } from "../issues";
import type { Theme } from "../modes/theme/theme";
import issuesDescription from "../prompts/tools/issues.md" with { type: "text" };
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const statusEnum = z.enum(["open", "in-progress", "fixed", "wontfix", "duplicate"]);

const addParams = z.object({
	op: z.literal("add"),
	category: z.string().min(1).describe("kebab-case bucket; e.g. `security`, `data-correctness`"),
	title: z.string().min(1).describe("short imperative phrase, ~5-10 words"),
	body: z.string().min(1).describe("markdown body; describe the bug, then add `## Fix` steps"),
	severity: severityEnum.optional(),
	status: statusEnum.optional(),
	location: z.array(z.string()).optional().describe("`path` or `path:line[-line]` references"),
	extra: z.record(z.string(), z.unknown()).optional().describe("extra frontmatter fields"),
});

const archiveParams = z.object({
	op: z.literal("archive"),
	id: z.number().int().positive(),
	reason: z.string().optional(),
	status: statusEnum.optional().describe("status to record on archive; default `fixed`"),
});

const unarchiveParams = z.object({
	op: z.literal("unarchive"),
	id: z.number().int().positive(),
	status: statusEnum.optional().describe("status to record on restore; default `open`"),
});

const listParams = z.object({
	op: z.literal("list"),
	category: z.string().optional(),
	archived: z.boolean().optional().describe("true → archived only; false → active only; omit → both"),
	severity: severityEnum.optional(),
	status: statusEnum.optional(),
	query: z.string().optional().describe("substring filter against title/body/frontmatter"),
	limit: z.number().int().positive().optional(),
});

const issuesSchema = z.discriminatedUnion("op", [addParams, archiveParams, unarchiveParams, listParams]);
export type IssuesToolParams = z.infer<typeof issuesSchema>;

export interface IssuesToolDetails {
	op: IssuesToolParams["op"];
	id?: number;
	category?: string;
	filename?: string;
	url?: string;
	archived?: boolean;
	title?: string;
	severity?: IssueSeverity;
	status?: IssueStatus;
	wasArchived?: boolean;
	wasActive?: boolean;
	listing?: IssueSummary[];
	/** First paragraph of the body, capped, for parent rendering. */
	bodyPreview?: string;
	/** First entry from `location[]`, captured for combined verdict views. */
	location?: string;
	/** Optional confidence (0..1), echoed back when the agent passes it. */
	confidence?: number;
	meta?: OutputMeta;
}

function urlForRecord(record: IssueRecord): string {
	return `issues://${record.filename}`;
}

function detailsFromRecord(op: IssuesToolParams["op"], record: IssueRecord): IssuesToolDetails {
	const location = record.frontmatter.location;
	const confidenceRaw = record.frontmatter.confidence;
	const confidence = typeof confidenceRaw === "number" ? confidenceRaw : undefined;
	return {
		op,
		id: record.id,
		category: record.category,
		filename: record.filename,
		url: urlForRecord(record),
		archived: record.archived,
		title: record.frontmatter.title,
		severity: record.frontmatter.severity,
		status: record.frontmatter.status,
		bodyPreview: extractBodyPreview(record.body),
		location: Array.isArray(location) && location.length > 0 ? location[0] : undefined,
		confidence,
	};
}

const BODY_PREVIEW_MAX = 200;
function extractBodyPreview(body: string): string | undefined {
	const trimmed = body.trim();
	if (!trimmed) return undefined;
	const firstPara = trimmed
		.split(/\n\s*\n/)[0]
		.replace(/\s+/g, " ")
		.trim();
	if (firstPara.length <= BODY_PREVIEW_MAX) return firstPara;
	return `${firstPara.slice(0, BODY_PREVIEW_MAX - 1).trimEnd()}…`;
}

function summarizeRecord(verb: string, record: IssueRecord, extra?: string): string {
	const tag = record.frontmatter.severity ? ` [${record.frontmatter.severity}]` : "";
	const status = record.frontmatter.status ? ` (${record.frontmatter.status})` : "";
	const archived = record.archived ? " (archived)" : "";
	const extraStr = extra ? `\n${extra}` : "";
	return `${verb} #${record.id} ${urlForRecord(record)}${tag}${status}${archived}\n${record.frontmatter.title}${extraStr}`;
}

async function executeAdd(
	session: ToolSession,
	params: z.infer<typeof addParams>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const input: AddIssueInput = {
		category: params.category,
		title: params.title,
		body: params.body,
		severity: params.severity,
		status: params.status,
		location: params.location,
		extra: params.extra,
	};
	const { record } = await addIssue(session.cwd, input);
	return toolResult<IssuesToolDetails>(detailsFromRecord("add", record))
		.text(summarizeRecord("Created", record))
		.done();
}

async function executeArchive(
	session: ToolSession,
	params: z.infer<typeof archiveParams>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const { record, wasArchived } = await archiveIssue(session.cwd, params.id, {
		reason: params.reason,
		status: params.status,
	});
	const details: IssuesToolDetails = { ...detailsFromRecord("archive", record), wasArchived };
	const verb = wasArchived ? "Already archived" : "Archived";
	return toolResult<IssuesToolDetails>(details).text(summarizeRecord(verb, record)).done();
}

async function executeUnarchive(
	session: ToolSession,
	params: z.infer<typeof unarchiveParams>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const { record, wasActive } = await unarchiveIssue(session.cwd, params.id, {
		status: params.status,
	});
	const details: IssuesToolDetails = { ...detailsFromRecord("unarchive", record), wasActive };
	const verb = wasActive ? "Already active" : "Unarchived";
	return toolResult<IssuesToolDetails>(details).text(summarizeRecord(verb, record)).done();
}

async function executeList(
	session: ToolSession,
	params: z.infer<typeof listParams>,
): Promise<AgentToolResult<IssuesToolDetails>> {
	const summaries = await listIssues(session.cwd, {
		category: params.category ? normalizeCategory(params.category) : undefined,
		archived: params.archived,
		severity: params.severity,
		status: params.status,
		query: params.query,
		limit: params.limit,
	});
	const scopeBits: string[] = [];
	if (params.archived === true) scopeBits.push("archived");
	else if (params.archived === false) scopeBits.push("active");
	else scopeBits.push("active+archive");
	if (params.category) scopeBits.push(`category=${params.category}`);
	if (params.severity) scopeBits.push(`severity=${params.severity}`);
	if (params.status) scopeBits.push(`status=${params.status}`);
	if (params.query) scopeBits.push(`q=${JSON.stringify(params.query)}`);
	const title = `# Issues (${summaries.length}, ${scopeBits.join(", ")})`;
	const text = renderIssueListing(summaries, {
		title,
		emptyText: "_No matching issues._",
		group: true,
		showArchived: params.archived === undefined,
	});
	return toolResult<IssuesToolDetails>({ op: "list", listing: summaries }).text(text).done();
}

export class IssuesTool implements AgentTool<typeof issuesSchema, IssuesToolDetails, Theme> {
	readonly name = "issues";
	readonly label = "Issues";
	readonly approval = "write" as const;
	readonly summary = "Add, archive, unarchive, and list project-local issues under .omp/issues/";
	readonly description = prompt.render(issuesDescription);
	readonly parameters = issuesSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<IssuesToolParams>) => {
		switch (args.op) {
			case "add":
				return args.title ? `filing issue: ${args.title}` : "filing issue";
			case "archive":
				return args.id ? `archiving issue #${args.id}` : "archiving issue";
			case "unarchive":
				return args.id ? `unarchiving issue #${args.id}` : "unarchiving issue";
			case "list":
				return "listing issues";
			default:
				return "managing issues";
		}
	};

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): IssuesTool | null {
		if (session.settings.get("issues.enabled") === false) return null;
		return new IssuesTool(session);
	}

	async execute(
		_toolCallId: string,
		params: IssuesToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<IssuesToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<IssuesToolDetails>> {
		return untilAborted(signal, async () => {
			try {
				switch (params.op) {
					case "add":
						return await executeAdd(this.session, params);
					case "archive":
						return await executeArchive(this.session, params);
					case "unarchive":
						return await executeUnarchive(this.session, params);
					case "list":
						return await executeList(this.session, params);
				}
			} catch (err) {
				if (err instanceof ToolError) throw err;
				const message = err instanceof Error ? err.message : String(err);
				throw new ToolError(`issues ${params.op} failed: ${message}`);
			}
		});
	}

	renderCall(args: Partial<IssuesToolParams>, _options: unknown, theme: Theme): Component {
		const op = args.op ?? "?";
		const title = op === "add" && "title" in args && typeof args.title === "string" ? args.title : "";
		const idLabel =
			(op === "archive" || op === "unarchive") && "id" in args && typeof args.id === "number" ? `#${args.id}` : "";
		const label = title || idLabel || "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("issues "))}${theme.fg("accent", op)} ${theme.fg("dim", label)}`,
			0,
			0,
		);
	}

	renderResult(result: AgentToolResult<IssuesToolDetails>, _options: unknown, _theme: Theme): Component {
		const text = result.content[0];
		const message = text?.type === "text" ? text.text : "";
		return new Text(message, 0, 0);
	}
}

// Mirror `report_finding`'s subprocess wiring so a reviewer subagent's
// `issues add` calls show up in the parent's extracted findings stream
// without requiring per-caller plumbing.
subprocessToolRegistry.register<IssuesToolDetails>("issues", {
	extractData: event => {
		if (event.isError) return undefined;
		const op = (event.args as Partial<IssuesToolParams> | undefined)?.op;
		if (op !== "add") return undefined;
		const details = event.result?.details as IssuesToolDetails | undefined;
		if (details?.op !== "add") return undefined;
		return details;
	},
	renderInline: (data, theme) => {
		const severity = data.severity ? `[${data.severity}] ` : "";
		const url = data.url ?? `issues://${data.filename ?? "?"}`;
		const title = data.title ?? "(untitled)";
		return new Text(
			`${theme.fg("success", theme.status.success)} ${theme.fg("accent", severity)}#${data.id ?? "?"} ${title} ${theme.fg("dim", url)}`,
			0,
			0,
		);
	},
	renderFinal: (allData, theme, expanded) => {
		const container = new Container();
		const additions = allData.filter(d => d.op === "add");
		const displayCount = expanded ? additions.length : Math.min(5, additions.length);
		for (let i = 0; i < displayCount; i++) {
			const data = additions[i];
			const severity = data.severity ? `[${data.severity}] ` : "";
			const url = data.url ?? `issues://${data.filename ?? "?"}`;
			const title = data.title ?? "(untitled)";
			container.addChild(
				new Text(`  ${theme.fg("accent", severity)}#${data.id ?? "?"} ${title} ${theme.fg("dim", url)}`, 0, 0),
			);
		}
		if (additions.length > displayCount) {
			container.addChild(new Text(theme.fg("dim", `  … ${additions.length - displayCount} more filed`), 0, 0));
		}
		return container;
	},
});
