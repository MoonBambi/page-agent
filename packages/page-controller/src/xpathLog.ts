/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 *
 * The xpath log: what an element selection records, how candidate precise
 * xpaths are verified against the live DOM, and how entries are rendered.
 *
 * PageController owns the log buffer and calls into here. Everything about the
 * log's shape lives in this module, and nothing here reaches back into the
 * controller — the task's abort signal and the candidate provider are passed in.
 */
import { normalizeWhitespace } from './utils'
import {
	type XPathMatch,
	type XPathStatus,
	type XPathVerdict,
	findXPathForNode,
} from './xpathVerify'

/** Default local flows/log server (see `scripts/flows-server.mjs`). */
export const DEFAULT_LOG_SERVER_URL = 'http://127.0.0.1:8787'

/** Version of the JSON Lines schema written by `exportXPathLog`. */
export const XPATH_LOG_SCHEMA_VERSION = 1

/**
 * Snapshot of an element the LLM just selected, used to generate precise xpaths.
 * It carries everything a generator needs: the raw structural path, the
 * element's own attributes/HTML and the visible ancestor chain (whose
 * attributes/text are needed to anchor selectors inside dialogs or table rows).
 */
export interface XPathSnapshot {
	/** Raw structural xpath recorded by the DOM tree (positional, brittle). */
	rawXpath: string
	tagName: string
	attributes: Record<string, string>
	/** Full outerHTML of the element itself (may be trimmed for very large nodes). */
	outerHTML: string
	/** Trimmed text content of the element. */
	text: string
	/** Visible ancestors from parentElement up to (and including) <body>. */
	ancestors: {
		tagName: string
		attributes: Record<string, string>
		/** Trimmed text content, useful for table-row anchoring. */
		text: string
	}[]
}

/**
 * Generates candidate precise (attribute-based) xpaths for a selected element.
 * Implemented by the agent layer (LLM-backed); PageController only verifies the
 * candidates against the live DOM and never talks to an LLM itself.
 *
 * @param snapshot - What the element looks like right now (see XPathSnapshot).
 * @param signal - Signal of the running task (see `setTaskAbortSignal`). Auxiliary
 * work must stop together with the task, so an implementation that calls out —
 * an LLM request, for instance — has to honour it and reject with an AbortError.
 * @returns Candidate xpaths, most preferred first; `[]` when the generator ran
 * but produced nothing usable; `null` when it did not run at all (disabled,
 * aborted or failed). That difference is what tells a reader of the log whether
 * a missing selector is the page's fault or the generator's.
 * @note Must not throw: report a failure through the return value and your own
 * logging. Throwing is handled as a contract violation, and is reported as such.
 */
export type XPathCandidateProvider = (
	snapshot: XPathSnapshot,
	signal?: AbortSignal
) => Promise<string[] | null>

/**
 * One logged element selection. The task's log is exported as JSON Lines
 * (one JSON object per selection) so the entries can be consumed by tooling.
 *
 * @note `schemaVersion` is written first so a consumer can refuse a file it does
 * not understand: entries without it predate versioning.
 */
export interface XPathLogEntry {
	/** Version of this schema; see `XPATH_LOG_SCHEMA_VERSION`. */
	schemaVersion: number
	/** Local time of the selection, e.g. `10:30:05`. */
	time: string
	/** The page-agent action performed on the element: click/input_text/... */
	action: string
	/** Index of the element in the DOM tree at selection time. */
	index: number
	/** Raw structural xpath recorded by the DOM tree (positional, brittle). */
	xpath: string
	/** Short text description of the element from the DOM tree. */
	elementText?: string
	/** `checked` state for checkbox/radio inputs. */
	checked?: boolean
	/** Current value for form controls (redacted for password inputs). */
	value?: string
	/** Trimmed text content of the element. */
	text?: string
	/** Flattened outerHTML snippet of the element. */
	html?: string
	/** Action-specific payload, e.g. `input=<redacted>` or `option=foo`. */
	extra?: string
	/**
	 * Verified selector for this element: it selects exactly one node in the live
	 * DOM, and that node is the one the action targeted. Present exactly when
	 * `preciseXpathStatus` is `attribute` or `positional`.
	 */
	preciseXpath?: string
	/**
	 * Outcome of the live check; the one field to read to know whether this
	 * selection has a reusable selector. Absent when precise-xpath logging is
	 * off, which is the only case where no check was attempted.
	 * @see XPathStatus
	 */
	preciseXpathStatus?: XPathStatus
	/** 1-based document-order position used by a `positional` selector. */
	preciseXpathIndex?: number
	/** How many nodes the `positional` selector's base matched. */
	preciseXpathMatchCount?: number
	/**
	 * A candidate that selected exactly one node *other* than the targeted one.
	 * Recorded even when another candidate was accepted, because it is evidence
	 * the generator aimed at the wrong element.
	 */
	preciseXpathOffTarget?: string
}

/**
 * Collect the snapshot handed to the precise-xpath provider: the raw path, the
 * element's own attributes/HTML/text, plus the visible ancestor chain (needed
 * to anchor selectors inside dialogs or table rows).
 */
export function collectSnapshot(element: HTMLElement, xpath: string): XPathSnapshot {
	const attributesOf = (el: Element): Record<string, string> => {
		const out: Record<string, string> = {}
		for (const name of el.getAttributeNames?.() ?? []) {
			const value = el.getAttribute(name)
			if (value !== null) out[name] = value
		}
		return out
	}
	const shortText = (el: Element | null): string =>
		normalizeWhitespace(el?.textContent ?? '').slice(0, 200)

	const ancestors: XPathSnapshot['ancestors'] = []
	let current: HTMLElement | null = element.parentElement
	while (current && ancestors.length < 6) {
		ancestors.push({
			tagName: current.tagName.toLowerCase(),
			attributes: attributesOf(current),
			text: shortText(current),
		})
		if (current === document.body) break
		current = current.parentElement
	}

	return {
		rawXpath: xpath,
		tagName: element.tagName.toLowerCase(),
		attributes: attributesOf(element),
		outerHTML: normalizeWhitespace(element.outerHTML).slice(0, 2000),
		text: shortText(element),
		ancestors,
	}
}

/**
 * Fill the element's own details into a log entry:
 * - `checked` for checkboxes/radios
 * - `value` for form controls that carry a non-empty value (redacted for
 *   password inputs, whose content is a secret)
 * - `text` trimmed text content
 * - `html` flattened outerHTML snippet
 */
export function fillElementDetails(entry: XPathLogEntry, element: HTMLElement | null): void {
	if (!element) return
	const tag = element.tagName.toLowerCase()
	const input = element as HTMLInputElement
	const isPasswordInput = tag === 'input' && input.type === 'password'

	if (tag === 'input' && (input.type === 'checkbox' || input.type === 'radio')) {
		entry.checked = input.checked
	} else if (isPasswordInput) {
		entry.value = '<redacted>'
	} else if (tag !== 'button' && typeof input.value === 'string' && input.value !== '') {
		entry.value = normalizeWhitespace(input.value).slice(0, 120)
	}

	const text = normalizeWhitespace(element.textContent ?? '')
	if (text) entry.text = text.slice(0, 120)

	let html = normalizeWhitespace(element.outerHTML)
	if (isPasswordInput) html = html.replace(/ value="[^"]*"/gi, ' value="<redacted>"')
	if (html) entry.html = html.slice(0, 250)
}

/**
 * Ask the provider for candidate precise xpaths and verify them against the live
 * DOM. The best tier wins; see `findXPathForNode` for the ranking.
 *
 * Candidates are evaluated in the element's own root tree
 * (`element.getRootNode()`, i.e. the document, a shadow root or an iframe
 * document), which is also the tree the raw structural xpath is relative to.
 *
 * @returns The verdict. Never throws; a missing verdict is reported as the
 * `not-generated` status, so an unusable element simply keeps its raw xpath.
 */
export async function resolvePreciseXpath(options: {
	element: HTMLElement
	xpath: string
	provider: XPathCandidateProvider
	signal?: AbortSignal
}): Promise<XPathVerdict> {
	const { element, xpath, provider, signal } = options
	// Nothing to verify with (e.g. plain jsdom): recording a verdict would be a guess.
	if (typeof document === 'undefined' || typeof document.evaluate !== 'function') {
		return { status: 'not-generated' }
	}
	if (signal?.aborted) return { status: 'not-generated' }

	const snapshot = collectSnapshot(element, xpath)
	let candidates: string[] | null
	try {
		candidates = await provider(snapshot, signal)
	} catch (error) {
		// The provider contract forbids throwing, so this is a violation of it.
		console.warn('[PageController] Precise xpath provider threw:', errorMessage(error))
		return { status: 'not-generated' }
	}
	if (!candidates) return { status: 'not-generated' }

	const contextNode = element.getRootNode()
	const snapshotType =
		(typeof XPathResult !== 'undefined' && XPathResult.ORDERED_NODE_SNAPSHOT_TYPE) || 7
	const match = (candidate: string): XPathMatch<Node> => {
		// The snapshot is materialized once, in document order, which is the order
		// a positional selector counts in; `nodeAt` is lazy so the walk stops as
		// soon as the target is found.
		const result = document.evaluate(candidate, contextNode, null, snapshotType, null)
		return {
			count: result.snapshotLength,
			nodeAt: (index) => result.snapshotItem(index) ?? undefined,
		}
	}
	return findXPathForNode(candidates, match, element)
}

/** Render the one-line console summary of a selection. */
export function formatSelectedElementLine(entry: XPathLogEntry): string {
	const head = `[${entry.time}] ${entry.action} index=${entry.index} xpath=${entry.xpath}`
	const details = [
		entry.elementText && `element=${entry.elementText}`,
		entry.preciseXpathStatus && `precise_xpath_status=${entry.preciseXpathStatus}`,
		entry.preciseXpathStatus === 'positional' && `match_count=${entry.preciseXpathMatchCount}`,
		entry.preciseXpath && `precise_xpath=${entry.preciseXpath}`,
	].filter((part): part is string => !!part)

	return `[PageController] LLM selected element -> ${[head, ...details].join(' ')}`
}

/** Render entries as JSON Lines: one JSON object per selection. */
export function serializeXPathLog(entries: readonly XPathLogEntry[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/**
 * Persist entries as a brand new file. Handed to the local log server first
 * (`POST /logs`, see `scripts/flows-server.mjs`), which writes it into the
 * project `logs/` dir — this works in any Chromium environment, including
 * embedded desktop clients that have no download UI. When the server is
 * unreachable, a real browser download is used as a fallback.
 *
 * @returns Number of entries persisted; 0 when there is nothing to export or
 * nothing could be persisted, in which case the caller keeps them for a retry.
 */
export async function exportXPathLog(options: {
	entries: readonly XPathLogEntry[]
	filename: string
	serverUrl?: string
}): Promise<number> {
	const { entries, filename } = options
	const count = entries.length
	if (count === 0) {
		console.warn(
			'[PageController] XPath log is empty — no LLM element selections were recorded for this task.'
		)
		return 0
	}

	const content = serializeXPathLog(entries)
	const serverUrl = (options.serverUrl ?? DEFAULT_LOG_SERVER_URL).replace(/\/+$/, '')
	console.info(
		`[PageController] Exporting ${count} xpath log entr${count === 1 ? 'y' : 'ies'} to log server (${serverUrl})...`
	)

	try {
		const response = await fetch(`${serverUrl}/logs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: filename, content }),
		})
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const result = (await response.json()) as { file?: string }
		console.info(
			`[PageController] XPath log exported -> ${result.file ?? `${serverUrl}/logs/${filename}`}`
		)
		return count
	} catch (error) {
		console.error(
			`[PageController] Log server unreachable (${serverUrl}): ${errorMessage(error)}. ` +
				'Make sure the flows server is running: npm run flows'
		)
	}

	if (await downloadViaBrowser(filename, content)) return count

	// Nothing persisted: keep the entries so a later export can retry them.
	console.warn(
		`[PageController] XPath log export failed — ${count} entr${count === 1 ? 'y' : 'ies'} kept in memory for the next export. ` +
			'Each selected element was already printed to the console above.'
	)
	return 0
}

/**
 * Fallback export path: trigger a real browser download of the log file.
 * Used when the local log server is unreachable.
 * @returns false when no download API is available (e.g. Node or a sandboxed iframe).
 */
async function downloadViaBrowser(filename: string, content: string): Promise<boolean> {
	try {
		if (
			typeof document === 'undefined' ||
			typeof URL === 'undefined' ||
			typeof Blob === 'undefined' ||
			!URL.createObjectURL
		) {
			return false
		}
		const blob = new Blob([content], { type: 'application/x-ndjson;charset=utf-8' })
		const url = URL.createObjectURL(blob)
		const link = document.createElement('a')
		link.href = url
		link.download = filename
		document.body.appendChild(link)
		link.click()
		link.remove()
		setTimeout(() => URL.revokeObjectURL(url), 1_000)
		console.info(`[PageController] XPath log exported via browser download -> ${filename}`)
		return true
	} catch (error) {
		console.error(`[PageController] Browser download of xpath log failed: ${errorMessage(error)}`)
		return false
	}
}

/** Message of an unknown thrown value, for logging. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
