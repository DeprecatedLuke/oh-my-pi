/**
 * Antigravity CLI plan quota, read through the official agy binary.
 *
 * `agy -p /usage` answers from agy's own login without starting an agent turn
 * and prints one tab-separated row per quota bucket:
 * `<group>\t<window label>\t<NN>%\t<ISO reset>`. omp never calls Google's
 * quota endpoint itself; it stages the account grant into an isolated
 * `--gemini_dir` (as inference does) and parses agy's output.
 */
import * as path from "node:path";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { agyGeminiDir, resolveAgyBinary } from "../providers/antigravity-cli/binary";
import { agyCredentialEnv, agyCredentialKey, stageAgyCredentials } from "../providers/antigravity-cli/credentials";
import { buildUsageAmount, DAY_MS, HOUR_MS, parseIsoTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "antigravity-cli";
const USAGE_TIMEOUT_MS = 60_000;

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "quota"
	);
}

function classifyWindow(label: string): UsageWindow {
	const normalized = label.trim().toLowerCase();
	if (/week|7\s*d/.test(normalized)) return { id: "7d", label: "Weekly", durationMs: WEEK_MS };
	if (/five hour|5\s*h/.test(normalized)) return { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS };
	if (/dai|24\s*h/.test(normalized)) return { id: "daily", label: "Daily", durationMs: DAY_MS };
	return { id: slug(label), label: label.trim() };
}

/** Quota rows of `agy -p /usage`; lines that are not `group\tlabel\tNN%[\treset]` are ignored. */
export function parseAgyUsageRows(output: string): UsageLimit[] {
	const limits: UsageLimit[] = [];
	for (const line of output.split(/\r?\n/)) {
		const [group, label, percent, reset] = line.split("\t").map(column => column.trim());
		if (!group || !label || !percent) continue;
		const match = /^(\d+(?:\.\d+)?)%$/.exec(percent);
		if (!match) continue;
		const remaining = Number(match[1]);
		if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue;
		const usedFraction = 1 - remaining / 100;
		const descriptor = classifyWindow(label);
		const resetsAt = parseIsoTimestamp(reset);
		const window: UsageWindow = resetsAt !== undefined ? { ...descriptor, resetsAt } : descriptor;
		limits.push({
			id: `${PROVIDER}:${slug(group)}:${window.id}`,
			label: group,
			scope: { provider: PROVIDER, tier: group, windowId: window.id, shared: true },
			window,
			amount: buildUsageAmount({
				used: undefined,
				limit: undefined,
				remaining: undefined,
				usedFraction,
				unit: "percent",
			}),
			status: usageStatus(usedFraction),
		});
	}
	return limits;
}

/** The registry's structured api-key envelope for an OAuth usage credential. */
function agyApiKey(credential: UsageFetchParams["credential"]): string | undefined {
	if (credential.type !== "oauth" || !credential.accessToken || !credential.refreshToken) return undefined;
	if (credential.expiresAt === undefined) return undefined;
	return JSON.stringify({
		token: credential.accessToken,
		refreshToken: credential.refreshToken,
		expiresAt: credential.expiresAt,
		email: credential.email,
		accountId: credential.accountId,
	});
}

async function fetchAntigravityCliUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const apiKey = agyApiKey(params.credential);
	if (!apiKey) return null;
	let geminiDir: string;
	try {
		// A directory of its own: a running ACP conversation keeps the inference one.
		geminiDir = path.join(agyGeminiDir(), "usage", agyCredentialKey(apiKey));
		await stageAgyCredentials(apiKey, geminiDir);
	} catch (error) {
		ctx.logger?.debug("Antigravity CLI usage: credential not stageable", { error: String(error) });
		return null;
	}
	const binary = await resolveAgyBinary(ctx.fetch);
	const signal = params.signal
		? AbortSignal.any([params.signal, AbortSignal.timeout(USAGE_TIMEOUT_MS)])
		: AbortSignal.timeout(USAGE_TIMEOUT_MS);
	const child = Bun.spawn([binary, "--gemini_dir", geminiDir, "-p", "/usage"], {
		cwd: geminiDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal,
		env: { ...Bun.env, ...agyCredentialEnv(), AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		// The first line only: agy follows eligibility errors with a sign-in URL.
		const reason = stderr.trim().split("\n")[0]?.slice(0, 200);
		ctx.logger?.warn("Antigravity CLI usage failed", { exitCode, reason });
		return null;
	}
	const limits = parseAgyUsageRows(stdout);
	if (limits.length === 0) {
		ctx.logger?.warn("Antigravity CLI usage returned no quota rows", { length: stdout.length });
		return null;
	}
	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { source: "agy -p /usage", email: params.credential.email },
	};
}

export const antigravityCliUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchAntigravityCliUsage,
	supports: params => params.provider === PROVIDER && agyApiKey(params.credential) !== undefined,
	validatesCredentials: false,
};
