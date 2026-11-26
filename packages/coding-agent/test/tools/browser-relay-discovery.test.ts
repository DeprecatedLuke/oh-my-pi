import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { TempDir } from "@oh-my-pi/pi-utils";
import { discoverRelayEndpoints } from "../../src/tools/browser/relay/discovery";

const LOOPBACK_IPV4_HEX = os.endianness() === "BE" ? "7F000001" : "0100007F";
// Beyond Linux's max pid_max (4194304) so process.kill(pid, 0) deterministically fails with ESRCH.
const FOREIGN_PID = 2_000_000_000;

function procNetTcpRow(localHex: string, port: number, state: string, uid: number): string {
	const portHex = port.toString(16).toUpperCase().padStart(4, "0");
	return `   0: ${localHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 12345 1 0000000000000000 100 0 0 10 0`;
}

describe("discoverRelayEndpoints", () => {
	let tmp: TempDir;
	let endpointsDir: string;

	beforeEach(async () => {
		tmp = await TempDir.create("@omp-relay-discovery-");
		endpointsDir = tmp.join("endpoints");
		await fs.mkdir(endpointsDir);
	});

	afterEach(async () => {
		await tmp.remove();
	});

	it("discovers an ESRCH endpoint when its loopback port is listening under the file owner's UID", async () => {
		const liveFile = tmp.join("endpoints", `${FOREIGN_PID}-28173`);
		const staleFile = tmp.join("endpoints", `${FOREIGN_PID}-28174`);
		const otherUidFile = tmp.join("endpoints", `${FOREIGN_PID}-28175`);
		const nonListenFile = tmp.join("endpoints", `${FOREIGN_PID}-28176`);
		const wildcardFile = tmp.join("endpoints", `${FOREIGN_PID}-28177`);
		for (const file of [liveFile, staleFile, otherUidFile, nonListenFile, wildcardFile]) {
			await Bun.write(file, "");
		}
		const ownerUid = (await fs.stat(liveFile)).uid;
		const procNetTcp = tmp.join("proc-net-tcp");
		await Bun.write(
			procNetTcp,
			[
				"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
				procNetTcpRow(LOOPBACK_IPV4_HEX, 28173, "0A", ownerUid),
				procNetTcpRow(LOOPBACK_IPV4_HEX, 28175, "0A", ownerUid + 1),
				procNetTcpRow(LOOPBACK_IPV4_HEX, 28176, "01", ownerUid),
				procNetTcpRow("00000000", 28177, "0A", ownerUid),
			].join("\n"),
		);

		expect(discoverRelayEndpoints({ dir: endpointsDir, procNetTcpPath: procNetTcp })).toEqual([
			"http://127.0.0.1:28173",
		]);
	});

	it("prefers a live same-namespace PID over a newer cross-namespace fallback", async () => {
		const liveFile = tmp.join("endpoints", `${process.pid}-29100`);
		const fallbackFile = tmp.join("endpoints", `${FOREIGN_PID}-29101`);
		await Bun.write(liveFile, "");
		await Bun.write(fallbackFile, "");
		const oldTime = new Date(Date.now() - 60_000);
		const newTime = new Date();
		await fs.utimes(liveFile, oldTime, oldTime);
		await fs.utimes(fallbackFile, newTime, newTime);

		const ownerUid = (await fs.stat(fallbackFile)).uid;
		const procNetTcp = tmp.join("proc-net-tcp");
		await Bun.write(procNetTcp, procNetTcpRow(LOOPBACK_IPV4_HEX, 29101, "0A", ownerUid));

		expect(discoverRelayEndpoints({ dir: endpointsDir, procNetTcpPath: procNetTcp })).toEqual([
			"http://127.0.0.1:29100",
			"http://127.0.0.1:29101",
		]);
	});

	if (process.platform === "linux") {
		it("discovers a real Linux loopback listener across PID namespaces via /proc/net/tcp", async () => {
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
			try {
				await Bun.write(tmp.join("endpoints", `${FOREIGN_PID}-${server.port}`), "");
				expect(discoverRelayEndpoints({ dir: endpointsDir })).toEqual([`http://127.0.0.1:${server.port}`]);
			} finally {
				server.stop(true);
			}
			// Once the server stops listening, the stale file is no longer returned.
			expect(discoverRelayEndpoints({ dir: endpointsDir })).toEqual([]);
		});
	}
});
