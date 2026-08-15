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
	const normalized = allPaths.map(normalizePath);
	return buildPathNeedles(filePath).filter((needle) => {
		let owners = 0;
		for (const candidate of normalized) {
			if (candidate === needle || candidate.endsWith("/" + needle)) owners++;
			if (owners > 1) return false;
		}
		return owners === 1;
	});
}

/** Whether an extracted file reference can refer to at least one known path. */
export function isKnownPathReference(
	ref: string,
	knownPaths: readonly string[],
): boolean {
	const normalizedRef = normalizePath(ref).replace(/^\/+/, "");
	if (!normalizedRef) return false;
	const pathShaped = normalizedRef.includes("/");
	return knownPaths.some((path) => {
		const normalizedPath = normalizePath(path).replace(/^\/+/, "");
		if (
			normalizedPath === normalizedRef ||
			normalizedPath.endsWith("/" + normalizedRef)
		)
			return true;

		// The coarse file regex begins again after characters it cannot consume
		// (spaces, `@`, non-ASCII letters). Ground that exact trailing fragment,
		// but never an arbitrary mid-segment suffix such as `uth.ts` for `auth.ts`.
		if (normalizedPath.endsWith(normalizedRef)) {
			const boundary =
				normalizedPath[normalizedPath.length - normalizedRef.length - 1];
			if (boundary && !/[\w./-]/.test(boundary)) return true;
		}
		if (!pathShaped) return false;

		// A dotted directory may legitimately name a complete parent segment.
		// Never accept a partial segment such as `Foo.App` for `Foo.Application`.
		return normalizedPath.split("/").some((_, index, parts) =>
			parts
				.slice(index)
				.join("/")
				.startsWith(normalizedRef + "/"),
		);
	});
}
