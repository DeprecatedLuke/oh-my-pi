import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { ProviderHttpError } from "../error";
import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { buildUsageAmount, parseIsoTimestamp, usageStatus } from "./shared";

const MISTRAL_PROVIDER = "mistral";
const DEFAULT_API_BASE = "https://api.mistral.ai/v1";
const WHOAMI_URL = "https://console.mistral.ai/api/vibe/whoami";

/*
 * The account reads of the Mistral Vibe CLI (mistralai/mistral-vibe), each sent
 * with `Authorization: Bearer <api key>`:
 *
 * - `GET https://console.mistral.ai/api/vibe/whoami` (vibe/setup/auth/whoami.py)
 *   answers `{ plan_type: "CHAT" | "API" | "MISTRAL_CODE", plan_name, … }`; the
 *   type follows the key's scope, and a plan key minted by Vibe sign-in reads `CHAT`.
 * - `GET {api base}/billing/budget` (vibe/app_server/_billing.py) answers
 *   `{ vibe_budget, api_budget }`, each `{ usage_percentage, initial_budget,
 *   currency, reset_at, payg_enabled? }`. `usage_percentage` runs 0-100 and past
 *   100 once pay-as-you-go carries the overage; `reset_at` is an ISO timestamp.
 *   Members without the `see_org_inference_usage` permission get 403.
 * - `GET {api base}/billing/subscription` answers `{ plan_name, payg_enabled,
 *   vibe_payg_enabled }`; it names the billed plan and backs the budgets'
 *   pay-as-you-go flag. Best effort, like in the CLI.
 */

/** The monthly budget each key scope draws from. */
const KEY_BUDGETS = {
	chat: { field: "vibe_budget", paygField: "vibe_payg_enabled", id: "vibe-budget", label: "Vibe Monthly Budget" },
	api: { field: "api_budget", paygField: "payg_enabled", id: "api-budget", label: "API Monthly Budget" },
} as const;

type KeyScope = keyof typeof KEY_BUDGETS;

/** Vibe CLI `_CHAT_PLAN_TITLES`: billing and `/whoami` name chat plans alike. */
const CHAT_PLAN_TITLES: Record<string, string> = {
	FREE: "Free",
	INDIVIDUAL: "Pro",
	EDU: "Student",
	TEAM: "Team",
};

const MISTRAL_CODE_PLAN_TITLES: Record<string, string> = {
	F: "Mistral Code Free",
	E: "Mistral Code Enterprise",
};

interface AccountRead {
	status: number;
	payload: unknown;
}

function normalizeApiBase(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	return trimmed || DEFAULT_API_BASE;
}

async function readAccount(
	url: string,
	apiKey: string,
	ctx: UsageFetchContext,
	signal?: AbortSignal,
): Promise<AccountRead> {
	const response = await ctx.fetch(url, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${apiKey}`,
			"User-Agent": USER_AGENT,
		},
		signal,
	});
	let payload: unknown;
	try {
		payload = (await response.json()) as unknown;
	} catch {
		payload = undefined;
	}
	return { status: response.status, payload };
}

function upstreamDetail(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.detail === "string") return payload.detail;
	return typeof payload.message === "string" ? payload.message : undefined;
}

function rejected(endpoint: string, read: AccountRead): ProviderHttpError {
	const detail = upstreamDetail(read.payload);
	return new ProviderHttpError(
		`Mistral ${endpoint} endpoint returned ${read.status}${detail ? `: ${detail}` : ""}`,
		read.status,
	);
}

function planName(payload: unknown): string | undefined {
	if (!isRecord(payload) || typeof payload.plan_name !== "string") return undefined;
	return payload.plan_name.trim().toUpperCase() || undefined;
}

function planTitle(
	planType: string,
	whoamiPlan: string | undefined,
	billedPlan: string | undefined,
): string | undefined {
	switch (planType) {
		case "chat": {
			const title =
				(billedPlan && CHAT_PLAN_TITLES[billedPlan]) ?? (whoamiPlan && CHAT_PLAN_TITLES[whoamiPlan]) ?? whoamiPlan;
			return title ? `Vibe ${title}` : undefined;
		}
		case "api":
			return whoamiPlan?.includes("FREE") ? "API Free" : "API Scale";
		case "mistral_code":
			return whoamiPlan ? MISTRAL_CODE_PLAN_TITLES[whoamiPlan] : undefined;
		default:
			return undefined;
	}
}

function budgetStatus(usedFraction: number, payg: boolean): UsageStatus {
	// Pay-as-you-go bills usage past the budget instead of pausing the key.
	if (payg && usedFraction >= 1) return "warning";
	return usageStatus(usedFraction);
}

function buildBudgetLimit(scope: KeyScope, detail: Record<string, unknown>, payg: boolean): UsageLimit | undefined {
	const percentage = detail.usage_percentage;
	if (typeof percentage !== "number" || !Number.isFinite(percentage)) return undefined;
	const used = Math.max(0, percentage);
	const usedFraction = used / 100;
	const budget = KEY_BUDGETS[scope];
	// Budgets reset at the billing month, so the window has a deadline but no fixed span.
	const window: UsageWindow = { id: "monthly", label: "Monthly" };
	const resetsAt = parseIsoTimestamp(detail.reset_at);
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	return {
		id: budget.id,
		label: budget.label,
		scope: { provider: MISTRAL_PROVIDER, windowId: window.id, shared: true },
		window,
		amount: buildUsageAmount({ used, limit: 100, remaining: undefined, usedFraction, unit: "percent" }),
		status: budgetStatus(usedFraction, payg),
		...(payg ? { notes: ["Pay-as-you-go bills usage past the budget"] } : {}),
	};
}

async function fetchMistralUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== MISTRAL_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;
	const apiKey = credential.apiKey;
	const apiBase = normalizeApiBase(params.baseUrl);

	let whoami: AccountRead;
	let budget: AccountRead;
	let subscription: AccountRead | undefined;
	try {
		[whoami, budget, subscription] = await Promise.all([
			readAccount(WHOAMI_URL, apiKey, ctx, params.signal),
			readAccount(`${apiBase}/billing/budget`, apiKey, ctx, params.signal),
			readAccount(`${apiBase}/billing/subscription`, apiKey, ctx, params.signal).catch(() => undefined),
		]);
	} catch (error) {
		ctx.logger?.warn("Mistral usage fetch error", { error: String(error) });
		return null;
	}

	// A rejected key must throw so credential checks report it as invalid rather
	// than unknown; any other failure is transient and keeps the last-good report.
	if (whoami.status === 401 || whoami.status === 403) throw rejected("account", whoami);
	if (budget.status === 401) throw rejected("budget", budget);
	if (whoami.status < 200 || whoami.status >= 300 || !isRecord(whoami.payload)) {
		ctx.logger?.warn("Mistral account lookup failed", { status: whoami.status });
		return null;
	}
	const planType = typeof whoami.payload.plan_type === "string" ? whoami.payload.plan_type.trim().toLowerCase() : "";
	const subscriptionPayload =
		subscription && subscription.status >= 200 && subscription.status < 300 && isRecord(subscription.payload)
			? subscription.payload
			: undefined;
	const title = planTitle(planType, planName(whoami.payload), planName(subscriptionPayload));
	const metadata: Record<string, unknown> = {};
	if (title) metadata.planType = title;
	if (credential.email) metadata.email = credential.email;
	if (credential.accountId) metadata.accountId = credential.accountId;
	const report = (limits: UsageLimit[], notes?: string[]): UsageReport => ({
		provider: MISTRAL_PROVIDER,
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata,
		raw: { whoami: whoami.payload, budget: budget.payload, subscription: subscriptionPayload },
	});

	if (planType !== "chat" && planType !== "api") {
		return report([], ["Mistral reports no monthly budget for this key's plan."]);
	}
	if (budget.status === 403) {
		return report(
			[],
			[
				"Mistral withholds the organization budget from this key: reading it needs the see_org_inference_usage permission.",
			],
		);
	}
	if (budget.status < 200 || budget.status >= 300 || !isRecord(budget.payload)) {
		ctx.logger?.warn("Mistral budget fetch failed", { status: budget.status });
		return null;
	}

	const scope: KeyScope = planType;
	const detail = budget.payload[KEY_BUDGETS[scope].field];
	// The CLI shows a budget only when the plan grants one.
	if (
		!isRecord(detail) ||
		typeof detail.initial_budget !== "number" ||
		!Number.isFinite(detail.initial_budget) ||
		detail.initial_budget <= 0
	) {
		return report([], [`This Mistral plan has no ${scope === "chat" ? "Vibe" : "API"} monthly budget.`]);
	}
	const payg =
		typeof detail.payg_enabled === "boolean"
			? detail.payg_enabled
			: subscriptionPayload?.[KEY_BUDGETS[scope].paygField] === true;
	const limit = buildBudgetLimit(scope, detail, payg);
	if (!limit) {
		ctx.logger?.warn("Mistral budget response had no usage percentage", { budget: KEY_BUDGETS[scope].field });
		return null;
	}
	return report([limit]);
}

export const mistralUsageProvider: UsageProvider = {
	id: MISTRAL_PROVIDER,
	fetchUsage: fetchMistralUsage,
	// Vibe sign-in stores the minted plan key as a plain API key.
	supports: params =>
		params.provider === MISTRAL_PROVIDER && params.credential.type === "api_key" && Boolean(params.credential.apiKey),
	validatesCredentials: true,
};
