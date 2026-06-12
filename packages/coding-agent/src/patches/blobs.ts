import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NativePatchFileEntry, PatchStore } from "./types";
import { isHash } from "./utils";

const REGULAR_FILE_MODE = 0o100000;
const SYMLINK_MODE = 0o120000;
const DEFAULT_FILE_MODE = 0o100644;

export interface FileSnapshot {
	hash: string;
	mode: number;
	size: number;
	content: Uint8Array;
	isSymlink: boolean;
}

export function hashBytes(content: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function encodeText(content: string): Uint8Array {
	return new TextEncoder().encode(content);
}

export function modeForRegularFile(mode: number): number {
	return REGULAR_FILE_MODE | (mode & 0o777);
}

export function filePermissionMode(entry: Pick<NativePatchFileEntry, "mode">): number {
	const mode = entry.mode ?? DEFAULT_FILE_MODE;
	return mode & 0o777;
}

export function isSymlinkMode(mode: number | undefined): boolean {
	return mode === SYMLINK_MODE;
}

export async function readFileSnapshot(filePath: string): Promise<FileSnapshot | null> {
	let stats: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stats = await fs.lstat(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (stats.isSymbolicLink()) {
		const target = await fs.readlink(filePath);
		const content = encodeText(target);
		return {
			content,
			hash: hashBytes(content),
			isSymlink: true,
			mode: SYMLINK_MODE,
			size: content.byteLength,
		};
	}
	if (!stats.isFile()) return null;
	const content = await Bun.file(filePath).bytes();
	return {
		content,
		hash: hashBytes(content),
		isSymlink: false,
		mode: modeForRegularFile(stats.mode),
		size: stats.size,
	};
}

export function blobPath(store: PatchStore, hash: string): string {
	if (!isHash(hash)) throw new Error(`invalid patch blob hash: ${hash}`);
	return path.join(store.blobsDir, hash.slice(0, 2), hash);
}

export async function writeBlob(store: PatchStore, content: Uint8Array): Promise<string> {
	const hash = hashBytes(content);
	const filePath = blobPath(store, hash);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	try {
		await fs.writeFile(filePath, content, { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	return hash;
}

export async function readBlob(store: PatchStore, hash: string): Promise<Uint8Array> {
	return Bun.file(blobPath(store, hash)).bytes();
}

export async function readBlobText(store: PatchStore, hash: string): Promise<string> {
	return Bun.file(blobPath(store, hash)).text();
}
