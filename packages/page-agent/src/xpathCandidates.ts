/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 *
 * Sanitizing of the candidate precise xpaths a generator returns.
 *
 * These rules are enforced here rather than only being asked for in the prompt,
 * so a model that ignores them cannot smuggle a fragile xpath into the log.
 */

/**
 * Matches a standalone `@id` attribute test.
 *
 * `@id` is banned: ids are routinely generated per render (framework prefixes,
 * SSR hydration suffixes, uuids), so an id-based xpath stops matching as soon as
 * the page renders again. `@data-id` / `@identifier`-style attributes are not
 * matched — only a bare `@id` qualifies.
 */
const ID_ATTRIBUTE_PATTERN = /@id(?![\w-])/

/** Whether an xpath relies on the `@id` attribute. */
export function referencesIdAttribute(xpath: string): boolean {
	return ID_ATTRIBUTE_PATTERN.test(xpath)
}

/**
 * What a sanitizer pass kept, and how much it dropped for `@id`.
 * The count is reported by the caller, so a model that ignores the prompt is
 * visible without re-testing the candidates for the same rule.
 */
export interface SanitizedXpathCandidates {
	/** Usable candidates, in the order the generator returned them. */
	candidates: string[]
	/** How many were dropped for relying on `@id`. */
	droppedForId: number
}

/**
 * Keep the usable candidates a generator returned, in order:
 * non-empty, unique, no `@id`, at most `limit` of them.
 *
 * Dropping a candidate is not a failure: PageController verifies the survivors
 * against the live DOM and an element without a usable candidate simply keeps
 * its raw structural xpath.
 */
export function sanitizeXpathCandidates(raw: unknown, limit = 5): SanitizedXpathCandidates {
	if (!Array.isArray(raw)) return { candidates: [], droppedForId: 0 }

	const candidates: string[] = []
	const seen = new Set<string>()
	let droppedForId = 0
	for (const candidate of raw) {
		if (typeof candidate !== 'string') continue
		const value = candidate.trim()
		if (!value || seen.has(value)) continue
		if (referencesIdAttribute(value)) {
			droppedForId++
			continue
		}
		seen.add(value)
		candidates.push(value)
		if (candidates.length >= limit) break
	}
	return { candidates, droppedForId }
}
