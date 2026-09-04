/**
 * Path-segment-suffix needle generator used by `extractOpenLoops` to attach
 * unresolved errors to specific files.
 *
 * The naive approach (basename match) produces massive false positives:
 * common filenames like `index.ts`, `types.ts`, `helpers.ts` appear in
 * almost every error message that mentions ANY file, so a "TypeError in
 * index.ts" snippet would erroneously surface as a bugfix loop for every
 * `index.ts` the session ever touched.
 *
 * The needles we emit are progressively-longer suffix slices:
 *
 *   path = "src/app/steps/persist.ts"
 *   needles = [
 *     "persist.ts",                       // basename, only when specific
 *     "steps/persist.ts",
 *     "app/steps/persist.ts",
 *     "src/app/steps/persist.ts",         // full path
 *   ]
 *
 * The caller matches each needle against the error message (substring,
 * case-insensitive). For generic basenames or very short ones we drop the
 * bare-basename needle so a bare "index.ts" in an error never attaches to
 * an unrelated `index.ts` from somewhere else in the tree.
 */

/**
 * Basenames that appear too often across unrelated files to be a useful
 * standalone match. Anything here is only attached when the error mentions
 * the full `dir/<basename>` segment.
 *
 * Exported so tests can verify the gate and so future contributors can
 * extend the list at one well-known location.
 */
export const GENERIC_BASENAMES: ReadonlySet<string> = new Set([
	"index.ts",
	"index.js",
	"index.tsx",
	"index.jsx",
	"types.ts",
	"helpers.ts",
	"utils.ts",
	"main.ts",
	"main.js",
	"mod.rs",
	"lib.rs",
	"__init__.py",
]);

/** Bare basenames shorter than this are also dropped (too weak a signal). */
export const MIN_BARE_BASENAME_LEN = 5;

/**
 * Build the suffix-needle list for a path. Returns an empty array for the
 * empty path; otherwise the longest needle is always the full normalized
 * path. All needles are lowercased so substring matching can be done with
 * `errorMessage.toLowerCase().includes(needle)` cheaply.
 */
export function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function buildPathNeedles(filePath: string): string[] {
	const parts = normalizePath(filePath).split("/").filter(Boolean);
	if (parts.length === 0) return [];
	const needles: string[] = [];
	const basename = parts[parts.length - 1];

	// Only attach by bare basename when it's specific enough to be a real
	// signal: not a generic filename, and not trivially short.
	if (
		!GENERIC_BASENAMES.has(basename) &&
		basename.length >= MIN_BARE_BASENAME_LEN
	) {
		needles.push(basename);
	}

	for (let j = parts.length - 2; j >= 0; j--) {
		needles.push(parts.slice(j).join("/"));
	}
	return needles;
}

/**
 * Return only suffixes that identify exactly one path in the supplied set.
 * A bare `auth.ts` is useful when unique, but must not let one monorepo package
 * satisfy verification for every sibling package that owns an `auth.ts`.
 */
export function buildUniquePathNeedles(
	filePath: string,
	allPaths: readonly string[],
): string[] {
	return buildUniquePathNeedlesFromIndex(
		filePath,
		buildPathNeedleOwnershipIndex(allPaths),
	);
}

// ponytail: bound eager suffix copies; oversized paths retain exact linear fallback.
const MAX_INDEXED_SUFFIX_CHARS = 1_024;

export interface PathNeedleOwnershipIndex {
	readonly counts: ReadonlyMap<string, number>;
	readonly normalizedPaths: readonly string[];
	readonly hasUnindexedSuffixes: boolean;
}

/** Count owners for every slash-boundary suffix once per supplied path. */
export function buildPathNeedleOwnershipIndex(
	allPaths: readonly string[],
): PathNeedleOwnershipIndex {
	const owners = new Map<string, number>();
	const normalizedPaths = allPaths.map(normalizePath);
	let hasUnindexedSuffixes = false;
	for (const normalized of normalizedPaths) {
		const suffixes = new Set([normalized]);
		for (let index = 0; index < normalized.length; index++) {
			if (normalized[index] !== "/") continue;
			if (normalized.length - index - 1 <= MAX_INDEXED_SUFFIX_CHARS) {
				suffixes.add(normalized.slice(index + 1));
			} else {
				hasUnindexedSuffixes = true;
			}
		}
		for (const suffix of suffixes) {
			owners.set(suffix, (owners.get(suffix) ?? 0) + 1);
		}
	}
	return { counts: owners, normalizedPaths, hasUnindexedSuffixes };
}

/** Hot-loop variant that reuses suffix ownership counts across many files. */
export function buildUniquePathNeedlesFromIndex(
	filePath: string,
	owners: PathNeedleOwnershipIndex,
): string[] {
	return buildPathNeedles(filePath).filter((needle) => {
		if (!owners.hasUnindexedSuffixes) return owners.counts.get(needle) === 1;
		let count = 0;
		for (const candidate of owners.normalizedPaths) {
			if (candidate === needle || candidate.endsWith("/" + needle)) count++;
			if (count > 1) return false;
		}
		return count === 1;
	});
}

export interface KnownPathReferenceIndex {
	/** Full paths and every slash-boundary suffix. */
	readonly segmentSuffixes: ReadonlySet<string>;
	/** Sorted view used for prefix lookups of complete parent paths. */
	readonly sortedSegmentSuffixes: readonly string[];
	/** Suffixes beginning after a character the coarse file regex cannot consume. */
	readonly boundarySuffixes: ReadonlySet<string>;
	/** Normalized source paths retained for exact fallback on oversized suffixes. */
	readonly normalizedPaths: readonly string[];
	readonly hasUnindexedSuffixes: boolean;
}

const PATH_CANDIDATE_CHAR_RE = /[\w./-]/;

/** Precompute every lookup shape accepted by `isKnownPathReference`. */
export function buildKnownPathReferenceIndex(
	knownPaths: readonly string[],
): KnownPathReferenceIndex {
	const segmentSuffixes = new Set<string>();
	const boundarySuffixes = new Set<string>();
	const normalizedPaths: string[] = [];
	let hasUnindexedSuffixes = false;

	for (const path of knownPaths) {
		const normalizedPath = normalizePath(path).replace(/^\/+/, "");
		if (!normalizedPath) continue;
		normalizedPaths.push(normalizedPath);
		segmentSuffixes.add(normalizedPath);

		for (let index = 0; index < normalizedPath.length; index++) {
			if (normalizedPath[index] === "/") {
				if (normalizedPath.length - index - 1 <= MAX_INDEXED_SUFFIX_CHARS) {
					segmentSuffixes.add(normalizedPath.slice(index + 1));
				} else {
					hasUnindexedSuffixes = true;
				}
			}
			if (
				index > 0 &&
				!PATH_CANDIDATE_CHAR_RE.test(normalizedPath[index - 1])
			) {
				if (normalizedPath.length - index <= MAX_INDEXED_SUFFIX_CHARS) {
					boundarySuffixes.add(normalizedPath.slice(index));
				} else {
					hasUnindexedSuffixes = true;
				}
			}
		}
	}

	return {
		segmentSuffixes,
		sortedSegmentSuffixes: [...segmentSuffixes].sort(),
		boundarySuffixes,
		normalizedPaths,
		hasUnindexedSuffixes,
	};
}

function matchesKnownPathReference(
	normalizedRef: string,
	normalizedPaths: readonly string[],
): boolean {
	const pathShaped = normalizedRef.includes("/");
	return normalizedPaths.some((normalizedPath) => {
		if (
			normalizedPath === normalizedRef ||
			normalizedPath.endsWith("/" + normalizedRef)
		) return true;
		if (normalizedPath.endsWith(normalizedRef)) {
			const boundary = normalizedPath[
				normalizedPath.length - normalizedRef.length - 1
			];
			if (boundary && !PATH_CANDIDATE_CHAR_RE.test(boundary)) return true;
		}
		if (!pathShaped) return false;
		return (
			normalizedPath.startsWith(normalizedRef + "/") ||
			normalizedPath.includes("/" + normalizedRef + "/")
		);
	});
}

function sortedHasPrefix(values: readonly string[], prefix: string): boolean {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle] < prefix) low = middle + 1;
		else high = middle;
	}
	return values[low]?.startsWith(prefix) ?? false;
}

/** Indexed variant for hot loops that check many references against one path set. */
export function isKnownPathReferenceInIndex(
	ref: string,
	index: KnownPathReferenceIndex,
): boolean {
	const normalizedRef = normalizePath(ref).replace(/^\/+/, "");
	if (!normalizedRef) return false;
	if (
		index.segmentSuffixes.has(normalizedRef) ||
		index.boundarySuffixes.has(normalizedRef)
	) {
		return true;
	}
	if (
		normalizedRef.includes("/") &&
		sortedHasPrefix(index.sortedSegmentSuffixes, normalizedRef + "/")
	) return true;
	return index.hasUnindexedSuffixes
		? matchesKnownPathReference(normalizedRef, index.normalizedPaths)
		: false;
}

/** Whether an extracted file reference can refer to at least one known path. */
export function isKnownPathReference(
	ref: string,
	knownPaths: readonly string[],
): boolean {
	const normalizedRef = normalizePath(ref).replace(/^\/+/, "");
	if (!normalizedRef) return false;
	return matchesKnownPathReference(
		normalizedRef,
		knownPaths.map((path) => normalizePath(path).replace(/^\/+/, "")),
	);
}
