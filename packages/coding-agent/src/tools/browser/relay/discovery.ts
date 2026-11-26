/** Per-user discovery for terminal clients; sidebar chats never publish an endpoint. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBrowserRelayInstallRegistryFile } from "@oh-my-pi/pi-utils/dirs";

const LOOPBACK_IPV4_HEX = os.endianness() === "BE" ? "7F000001" : "0100007F";
const TCP_LISTEN_STATE = "0A";

export interface DiscoverRelayEndpointsOptions {
	dir?: string;
	procNetTcpPath?: string;
}

function discoveryDir(): string {
	return path.join(path.dirname(getBrowserRelayInstallRegistryFile()), "endpoints");
}

/**
 * Loopback IPv4 TCP ports in `TCP_LISTEN` on Linux, mapped to owning socket UIDs.
 * Used when `process.kill(pid, 0)` returns `ESRCH` because the caller runs in a
 * separate PID namespace sharing the host network namespace.
 */
function readListeningLoopbackPorts(procNetTcpPath?: string): Map<number, Set<number>> | null {
	if (process.platform !== "linux" && procNetTcpPath === undefined) return null;
	let content: string;
	try {
		content = fs.readFileSync(procNetTcpPath ?? "/proc/net/tcp", "utf8");
	} catch {
		return null;
	}
	const ports = new Map<number, Set<number>>();
	for (const line of content.split("\n")) {
		const fields = line.trim().split(/\s+/);
		// Format: sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid ...
		if (fields.length < 8 || fields[3]?.toUpperCase() !== TCP_LISTEN_STATE) continue;
		const local = fields[1];
		const uidStr = fields[7];
		if (!local || !uidStr) continue;
		const sep = local.indexOf(":");
		if (sep === -1 || local.slice(0, sep).toUpperCase() !== LOOPBACK_IPV4_HEX) continue;
		const port = Number.parseInt(local.slice(sep + 1), 16);
		const uid = Number.parseInt(uidStr, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(uid)) continue;
		let uids = ports.get(port);
		if (!uids) {
			uids = new Set();
			ports.set(port, uids);
		}
		uids.add(uid);
	}
	return ports;
}

/** Publish an OS-assigned port for this host's lifetime. */
export async function publishRelayEndpoint(port: number): Promise<() => Promise<void>> {
	const file = path.join(discoveryDir(), `${process.pid}-${port}`);
	await Bun.write(file, "", { mode: 0o600 });
	return () => fs.promises.unlink(file).catch(() => {});
}

/** Discover live local relay hosts, preferring the most recently started. */
export function discoverRelayEndpoints(options?: DiscoverRelayEndpointsOptions): string[] {
	const dir = options?.dir ?? discoveryDir();
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	let listeningPorts: Map<number, Set<number>> | null | undefined;
	return names
		.flatMap(name => {
			const match = /^(\d+)-(\d+)$/.exec(name);
			if (!match) return [];
			const pid = Number(match[1]);
			const port = Number(match[2]);
			if (pid < 1 || port < 1 || port > 65535) return [];
			let pidAlive = false;
			try {
				process.kill(pid, 0);
				pidAlive = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") return [];
			}
			let stat: fs.Stats;
			try {
				stat = fs.statSync(path.join(dir, name));
			} catch {
				return [];
			}
			if (!pidAlive) {
				if (listeningPorts === undefined) {
					listeningPorts = readListeningLoopbackPorts(options?.procNetTcpPath);
				}
				if (!listeningPorts?.get(port)?.has(stat.uid)) return [];
			}
			return [{ port, started: stat.mtimeMs, pidAlive }];
		})
		.sort((a, b) => Number(b.pidAlive) - Number(a.pidAlive) || b.started - a.started)
		.map(({ port }) => `http://127.0.0.1:${port}`);
}
