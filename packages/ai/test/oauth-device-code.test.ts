import { describe, expect, it, vi } from "bun:test";
import { pollOAuthDeviceCodeFlow } from "@oh-my-pi/pi-ai/oauth";
import { createDeviceCodeLogin } from "@oh-my-pi/pi-ai/registry/engine/device-code";
import type { OAuthAuthInfo } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";

describe("OAuth device-code polling", () => {
	it("exports the legacy device-code poll helper for external providers", async () => {
		const value = await pollOAuthDeviceCodeFlow({
			poll: () => ({ status: "complete", value: { access: "token" } }),
		});

		expect(value).toEqual({ access: "token" });
	});

	it("surfaces provider failure messages", async () => {
		await expect(
			pollOAuthDeviceCodeFlow({
				poll: () => ({ status: "failed", message: "authorization denied" }),
			}),
		).rejects.toThrow("authorization denied");
	});

	it("keeps a successful poll that finishes after the deadline", async () => {
		let now = 1_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const value = await pollOAuthDeviceCodeFlow({
				expiresInSeconds: 1,
				poll: () => {
					now = 2_001;
					return { status: "complete", value: "authorized" };
				},
			});
			expect(value).toBe("authorized");
		} finally {
			clock.mockRestore();
		}
	});

	it("prefers caller cancellation over a completed poll", async () => {
		const controller = new AbortController();
		await expect(
			pollOAuthDeviceCodeFlow({
				signal: controller.signal,
				poll: () => {
					controller.abort();
					return { status: "complete", value: "authorized" };
				},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("cancels an in-flight poll when the caller aborts instead of waiting for the provider", async () => {
		const controller = new AbortController();
		const flow = pollOAuthDeviceCodeFlow({
			signal: controller.signal,
			poll: signal =>
				new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					controller.abort();
				}),
		});
		await expect(flow).rejects.toThrow("Login cancelled");
	});

	it("times out pending device flows", async () => {
		await expect(
			pollOAuthDeviceCodeFlow({
				expiresInSeconds: 0.001,
				poll: () => ({ status: "pending" }),
			}),
		).rejects.toThrow("Device flow timed out");
	});
});

describe("Declarative device-code login", () => {
	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	it("resolves a relative verification URI against the device endpoint and maps OpenCode Console credentials", async () => {
		const rule = authPolicyFor("opencode-go")?.login;
		if (rule?.kind !== "device-code") throw new Error("missing device-code policy for opencode-go");

		const requests: Array<{ url: string; body: string; contentType: string | null }> = [];
		const fetchImpl: FetchImpl = async (url, init) => {
			const target = String(url);
			requests.push({
				url: target,
				body: String(init?.body ?? ""),
				contentType: new Headers(init?.headers).get("content-type"),
			});
			if (target === "https://opencode.ai/console/auth/device/code") {
				// Console answers with a path; the user-facing URL must be absolute.
				return jsonResponse({
					device_code: "dc_console",
					user_code: "ABCD-EFGH",
					verification_uri: "/console/device",
					verification_uri_complete: "/console/device?user_code=ABCD-EFGH&client_id=omp",
					expires_in: 300,
					interval: 0,
				});
			}
			if (target === "https://opencode.ai/console/auth/device/token") {
				return jsonResponse({
					access_token: "console-access",
					refresh_token: "console-refresh",
					expires_in: 3600,
					org_id: "org_console_1",
				});
			}
			if (target === "https://opencode.ai/console/api/user") {
				return jsonResponse({ id: "user_console_1", email: "dev@example.com" });
			}
			throw new Error(`unexpected request: ${target}`);
		};

		let auth: OAuthAuthInfo | undefined;
		const credentials = await createDeviceCodeLogin(
			rule,
			"opencode-go",
		)({
			fetch: fetchImpl,
			onAuth: info => {
				auth = info;
			},
		});

		expect(auth?.url).toBe("https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=omp");
		expect(auth?.instructions).toContain("ABCD-EFGH");

		expect(requests.map(request => request.url)).toEqual([
			"https://opencode.ai/console/auth/device/code",
			"https://opencode.ai/console/auth/device/token",
			"https://opencode.ai/console/api/user",
		]);

		const deviceForm = new URLSearchParams(requests[0]?.body);
		expect(requests[0]?.contentType).toBe("application/x-www-form-urlencoded");
		expect(deviceForm.get("client_id")).toBe("omp");
		expect(deviceForm.get("supports_org_scope")).toBe("true");

		const pollForm = new URLSearchParams(requests[1]?.body);
		expect(pollForm.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(pollForm.get("device_code")).toBe("dc_console");

		expect(credentials).toMatchObject({
			access: "console-access",
			refresh: "console-refresh",
			orgId: "org_console_1",
			accountId: "user_console_1",
			email: "dev@example.com",
			apiEndpoint: "https://opencode.ai/inference/go",
		});
	});
});
