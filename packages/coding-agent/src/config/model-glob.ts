/**
 * Model-glob keyed maps (`retry.cyberFallbackModels`, `secrets.modelFiles`).
 *
 * Keys containing `/` match `provider/model-id`; every other key matches the
 * bare model id. `*` is the only metacharacter and matches any run, including
 * an empty one, so `*opus-*` matches `claude-opus-5-5` and `*` matches
 * everything. Matching is anchored and case-insensitive. An exact key beats
 * any glob; among globs the one pinning the longest literal run wins; a
 * remaining tie keeps configured order.
 */

const matcherCache = new Map<string, (subject: string) => boolean>();

function globMatcher(pattern: string): (subject: string) => boolean {
	let matcher = matcherCache.get(pattern);
	if (matcher) return matcher;
	if (!pattern.includes("*")) {
		const literal = pattern.toLowerCase();
		matcher = subject => subject.toLowerCase() === literal;
	} else {
		let source = "";
		for (const char of pattern) {
			source += char === "*" ? ".*" : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
		const regex = new RegExp(`^${source}$`, "i");
		matcher = subject => regex.test(subject);
	}
	matcherCache.set(pattern, matcher);
	return matcher;
}

/** Characters a glob key pins literally; the tie-breaker between matching globs. */
function literalLength(pattern: string): number {
	let length = 0;
	for (const char of pattern) if (char !== "*") length++;
	return length;
}

/**
 * The winning key of `keys` for `model`, or undefined when none matches.
 * `usable` filters keys out before ranking (e.g. keys with an empty value).
 */
export function matchModelGlob(
	keys: Iterable<string>,
	model: { provider: string; id: string },
	usable: (key: string) => boolean = () => true,
): string | undefined {
	const providerId = `${model.provider}/${model.id}`;
	let bestKey: string | undefined;
	let bestRank = -1;
	for (const key of keys) {
		if (!usable(key)) continue;
		const subject = key.includes("/") ? providerId : model.id;
		if (!globMatcher(key)(subject)) continue;
		// An exact key outranks every glob regardless of how much the glob pins.
		const rank = key.includes("*") ? literalLength(key) : Number.POSITIVE_INFINITY;
		if (rank <= bestRank) continue;
		bestKey = key;
		bestRank = rank;
	}
	return bestKey;
}
