import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type {
	AgentSessionEvent,
	AsyncJobSnapshot,
	AsyncJobSnapshotItem,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TERMINAL } from "@oh-my-pi/pi-tui";

const MAIN_OWNER_ID = "main-session";
const NESTED_OWNER_ID = "nested-agent";

type SnapshotOptions = { recentLimit?: number; scope?: "owner" | "all" };

function makeSnapshot(manager: AsyncJobManager, options?: SnapshotOptions): AsyncJobSnapshot {
	const ownerFilter = options?.scope === "all" ? undefined : { ownerId: MAIN_OWNER_ID };
	const summarize = (job: AsyncJob): AsyncJobSnapshotItem => ({
		id: job.id,
		type: job.type,
		status: job.status,
		label: job.label,
		startTime: job.startTime,
		agentType: job.agentType,
	});

	return {
		running: manager.getRunningJobs(ownerFilter).map(summarize),
		recent: manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(summarize),
		delivery: manager.getDeliveryState(ownerFilter),
	};
}

function makeContext(manager: AsyncJobManager): {
	ctx: InteractiveModeContext;
	session: {
		getAsyncJobSnapshot: (options?: SnapshotOptions) => AsyncJobSnapshot;
	};
} {
	const getAsyncJobSnapshot = (options?: SnapshotOptions): AsyncJobSnapshot => makeSnapshot(manager, options);
	const session = {
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		queuedMessageCount: 0,
		messages: [],
		getContextUsage: () => undefined,
		getAsyncJobSnapshot,
		hasPendingBackgroundJobs: () => {
			const snapshot = getAsyncJobSnapshot();
			return (
				snapshot.running.length > 0 ||
				snapshot.delivery.queued > 0 ||
				snapshot.delivery.delivering ||
				snapshot.delivery.pendingJobIds.length > 0
			);
		},
	};
	const ctx = {
		isInitialized: true,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		focusedAgentId: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, unknown>(),
		backgroundTaskCallIds: new Set<string>(),
		flushPendingModelSwitch: async () => {},
		flushPendingCommandOutput: () => {},
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			terminal: { columns: 120, setProgress: vi.fn() },
		},
		chatContainer: { removeChild: vi.fn() },
		statusContainer: { disposeChildren: vi.fn(), clear: vi.fn() },
		subagentContainer: { addChild: vi.fn(), removeChild: vi.fn() },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "main session" },
		settings: { get: () => false },
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		session,
		get viewSession() {
			return session;
		},
	} as unknown as InteractiveModeContext;
	return { ctx, session };
}

function makeAgentEndEvent(): Extract<AgentSessionEvent, { type: "agent_end" }> {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
	return { type: "agent_end", messages: [message] };
}

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			"completion.notify": "on",
			"error.notify": "off",
			"compaction.idleEnabled": false,
			"recap.enabled": false,
		},
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("EventController completion notification and nested-owner async jobs", () => {
	for (const mode of ["on", "bell"] as const) {
		it(`defers ${mode} completion output until a nested-owner job settles`, async () => {
			settings.override("completion.notify", mode);
			const notify = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
			const bell = vi.spyOn(TERMINAL, "ringBell").mockImplementation(() => {});
			const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
			const nestedGate = Promise.withResolvers<string>();
			const nestedJobId = manager.register("task", "nested work", async () => nestedGate.promise, {
				id: "nested-job",
				ownerId: NESTED_OWNER_ID,
			});
			const { ctx, session } = makeContext(manager);
			const controller = new EventController(ctx);

			try {
				// Rendering and cancellation stay owner-scoped, while the explicit all-owner
				// view exposes the nested job that must gate the terminal notification.
				expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
				expect(session.getAsyncJobSnapshot({ scope: "all" })?.running.map(job => job.id)).toContain(nestedJobId);

				await controller.handleEvent(makeAgentEndEvent());
				expect(notify).not.toHaveBeenCalled();
				expect(bell).not.toHaveBeenCalled();
				expect(manager.getRunningJobs({ ownerId: NESTED_OWNER_ID }).map(job => job.id)).toEqual([nestedJobId]);

				// Cancellation settles the nested owner without producing a follow-up delivery.
				expect(manager.cancel(nestedJobId, { ownerId: NESTED_OWNER_ID })).toBe(true);
				nestedGate.resolve("cancelled");
				await manager.waitForAll();

				// The existing refresh path sees global quiescence, flushes the retained
				// completion event, and must not emit it again on a later refresh.
				controller.refreshBackgroundJobs();
				controller.refreshBackgroundJobs();
				if (mode === "on") {
					expect(notify).toHaveBeenCalledTimes(1);
					expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Complete", type: "completion" }));
					expect(bell).toHaveBeenCalledTimes(0);
				} else {
					expect(bell).toHaveBeenCalledTimes(1);
					expect(notify).toHaveBeenCalledTimes(0);
				}
			} finally {
				nestedGate.resolve("cancelled");
				controller.dispose();
				await manager.dispose({ timeoutMs: 1_000 });
			}
		});
	}
});
