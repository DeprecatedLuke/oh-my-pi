/** Logged strings kept at most; older writes are forgotten and results computed before them recompute. */
const MAX_LOGGED_STRINGS = 4096;

/**
 * Version of a {@link SecretObfuscator}'s registry: every collection redaction
 * reads is a tracked collection bound to one revision, and each effective
 * write bumps it. Results reused across calls are keyed by `value`, so a write
 * can never leave a stale result in place — there is no separate invalidation
 * step to forget.
 *
 * Additive writes also log the strings they wrote (keys, values, string fields
 * of object values) under their post-bump revision, so a result computed at an
 * older revision can be revalidated by checking that none of those strings
 * concern its input, instead of being recomputed.
 */
export class RegistryRevision {
	value = 0;
	/** Every write after this revision is in the log; results from older revisions cannot be revalidated. */
	#floor = 0;
	/** Parallel arrays: `#strings[i]` was written at revision `#revisions[i]` (non-decreasing). */
	#revisions: number[] = [];
	#strings: string[] = [];

	/** A write the log cannot describe (e.g. a removal): forget the log so older results recompute. */
	bump(): void {
		this.value++;
		this.#floor = this.value;
		this.#revisions.length = 0;
		this.#strings.length = 0;
	}

	/** An additive write of `key` and `value`; their strings are logged under the new revision. */
	bumpWith(key: unknown, value?: unknown): void {
		this.value++;
		this.#log(key);
		this.#log(value);
		if (this.#strings.length > MAX_LOGGED_STRINGS) this.#trim();
	}

	/**
	 * Strings written after `revision`, or undefined when the log no longer
	 * covers every write since then.
	 */
	writtenSince(revision: number): readonly string[] | undefined {
		if (revision < this.#floor) return undefined;
		const revisions = this.#revisions;
		let low = 0;
		let high = revisions.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (revisions[mid] <= revision) low = mid + 1;
			else high = mid;
		}
		return low === revisions.length ? [] : this.#strings.slice(low);
	}

	#log(item: unknown): void {
		if (typeof item === "string") {
			this.#push(item);
		} else if (typeof item === "object" && item !== null) {
			for (const field of Object.values(item)) if (typeof field === "string") this.#push(field);
		}
	}

	#push(text: string): void {
		if (text.length === 0) return;
		this.#revisions.push(this.value);
		this.#strings.push(text);
	}

	/** Drop the older half of the log, whole revisions at a time. */
	#trim(): void {
		const revisions = this.#revisions;
		let cut = revisions.length >>> 1;
		const dropped = revisions[cut - 1];
		while (cut < revisions.length && revisions[cut] === dropped) cut++;
		this.#floor = dropped;
		revisions.splice(0, cut);
		this.#strings.splice(0, cut);
	}
}

// Both wrap a plain collection instead of subclassing it: reads are the hot
// path of redaction and stay on the engine's builtin Map/Set fast paths.

/** Map whose effective writes bump a {@link RegistryRevision}. */
export class TrackedMap<K, V> implements ReadonlyMap<K, V> {
	readonly #map = new Map<K, V>();
	readonly #revision: RegistryRevision;
	#version = 0;

	constructor(revision: RegistryRevision) {
		this.#revision = revision;
	}

	/** Number of effective writes to this map alone; lets derived data follow just this map. */
	get version(): number {
		return this.#version;
	}

	get size(): number {
		return this.#map.size;
	}

	get(key: K): V | undefined {
		return this.#map.get(key);
	}

	has(key: K): boolean {
		return this.#map.has(key);
	}

	set(key: K, value: V): this {
		if (this.#map.has(key) && this.#map.get(key) === value) return this;
		this.#map.set(key, value);
		this.#version++;
		this.#revision.bumpWith(key, value);
		return this;
	}

	keys(): MapIterator<K> {
		return this.#map.keys();
	}

	values(): MapIterator<V> {
		return this.#map.values();
	}

	entries(): MapIterator<[K, V]> {
		return this.#map.entries();
	}

	forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.#map) callback.call(thisArg, value, key, this);
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.#map[Symbol.iterator]();
	}
}

/** Set whose effective writes bump a {@link RegistryRevision}. */
export class TrackedSet<T> {
	readonly #set = new Set<T>();
	readonly #revision: RegistryRevision;

	constructor(revision: RegistryRevision) {
		this.#revision = revision;
	}

	get size(): number {
		return this.#set.size;
	}

	has(value: T): boolean {
		return this.#set.has(value);
	}

	add(value: T): this {
		if (this.#set.has(value)) return this;
		this.#set.add(value);
		this.#revision.bumpWith(value);
		return this;
	}

	[Symbol.iterator](): SetIterator<T> {
		return this.#set[Symbol.iterator]();
	}
}
