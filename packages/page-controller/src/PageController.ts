/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 *
 * PageController - Manages DOM operations and element interactions.
 * Designed to be independent of LLM and can be tested in unit tests.
 * All public methods are async for potential remote calling support.
 */
import {
	clickElement,
	getElementByIndex,
	inputTextElement,
	scrollHorizontally,
	scrollVertically,
	selectOptionElement,
} from './actions'
import * as dom from './dom'
import type { FlatDomTree, InteractiveElementDomNode } from './dom/dom_tree/type'
import { getPageInfo } from './dom/getPageInfo'
import { patchReact } from './patches/react'
import { isAnchorElement, normalizeWhitespace } from './utils'
import {
	XPATH_LOG_SCHEMA_VERSION,
	type XPathCandidateProvider,
	type XPathLogEntry,
	exportXPathLog,
	fillElementDetails,
	formatSelectedElementLine,
	resolvePreciseXpath,
} from './xpathLog'

// The xpath log's public surface lives in ./xpathLog; re-exported so consumers
// of this package entry point keep a single import site.
export {
	DEFAULT_LOG_SERVER_URL,
	type XPathCandidateProvider,
	type XPathLogEntry,
	type XPathSnapshot,
} from './xpathLog'
export type { XPathStatus } from './xpathVerify'

/**
 * Configuration for PageController
 */
export interface PageControllerConfig extends dom.DomConfig {
	/** Enable visual mask overlay during operations (default: false) */
	enableMask?: boolean
	/**
	 * Base URL of the local flows/log server (see `scripts/flows-server.mjs`).
	 * XPath logs are handed to this server (`POST /logs`, landing in the
	 * project `logs/` dir); when the server is unreachable they fall back to a
	 * browser download. Defaults to `DEFAULT_LOG_SERVER_URL`.
	 */
	xpathLogServerUrl?: string
	/**
	 * When enabled, each element the LLM selects is also logged with a precise,
	 * attribute-based xpath (e.g. `//input[@class='x' and @placeholder='y']`).
	 *
	 * Candidate xpaths come from `preciseXpathProvider` (LLM-backed, injected by
	 * the agent layer — PageController stays LLM-free) and are verified against
	 * the live DOM: a candidate that selects exactly the selected element wins.
	 * A candidate that uniquely selects a *different* element is a wrong answer,
	 * and is never logged as this element's selector. When no candidate is
	 * unambiguous, the narrowest candidate containing the element is logged with
	 * its document-order position. Each entry records which of those happened in
	 * `XPathLogEntry.preciseXpathStatus`; elements whose candidates are usable in
	 * no way keep the raw structural xpath only. Default: false.
	 */
	enablePreciseXpath?: boolean
	/**
	 * Provider that turns the snapshot of a selected element into candidate
	 * precise xpaths. Only consulted when `enablePreciseXpath` is true.
	 * @see XPathCandidateProvider
	 */
	preciseXpathProvider?: XPathCandidateProvider
}

/**
 * Structured browser state for LLM consumption
 */
export interface BrowserState {
	url: string
	title: string
	/** Page info + scroll position hint (e.g. "Page info: 1920x1080px...\n[Start of page]") */
	header: string
	/** Simplified HTML of interactive elements */
	content: string
	/** Page footer hint (e.g. "... 300 pixels below ..." or "[End of page]") */
	footer: string
}

interface ActionResult {
	success: boolean
	message: string
}

/**
 * PageController manages DOM state and element interactions.
 * It provides async methods for all DOM operations, keeping state isolated.
 *
 * @lifecycle
 * - beforeUpdate: Emitted before the DOM tree is updated.
 * - afterUpdate: Emitted after the DOM tree is updated.
 */
export class PageController extends EventTarget {
	private config: PageControllerConfig

	/** Corresponds to eval_page in browser-use */
	private flatTree: FlatDomTree | null = null

	/**
	 * All highlighted index-mapped interactive elements
	 * Corresponds to DOMState.selector_map in browser-use
	 */
	private selectorMap = new Map<number, InteractiveElementDomNode>()

	/** Index -> element text description mapping */
	private elementTextMap = new Map<number, string>()

	/**
	 * XPath log entries for the elements the LLM selected during the current
	 * task. Each entry is printed to the console when the element is selected
	 * and exported as JSON Lines when the task ends (see downloadXPathLog).
	 */
	private xpathLog: XPathLogEntry[] = []

	/**
	 * Abort signal of the task currently being executed, if any. Auxiliary work
	 * that PageController starts on its own (precise-xpath generation) is
	 * cancelled together with the task, so the agent attaches its task signal
	 * here. Undefined means "no task running".
	 */
	private taskAbortSignal?: AbortSignal

	/**
	 * Simplified HTML for LLM consumption.
	 * Corresponds to clickable_elements_to_string in browser-use
	 */
	private simplifiedHTML = '<EMPTY>'

	/** last time the tree was updated */
	private lastTimeUpdate = 0

	/** Whether the tree has been indexed at least once */
	private isIndexed = false

	/** Visual mask overlay for blocking user interaction during automation */
	private mask: InstanceType<typeof import('./mask/SimulatorMask').SimulatorMask> | null = null
	private maskReady: Promise<void> | null = null

	constructor(config: PageControllerConfig = {}) {
		super()

		this.config = config

		patchReact(this)

		if (config.enableMask) this.initMask()
	}

	/**
	 * Attach (or clear, with `undefined`) the abort signal of the task being
	 * executed. Auxiliary work started by PageController is cancelled by it, so
	 * the agent attaches its task signal when a task starts and clears it once
	 * the task has settled.
	 */
	setTaskAbortSignal(signal?: AbortSignal): void {
		this.taskAbortSignal = signal
	}

	/**
	 * Initialize mask asynchronously (dynamic import to avoid CSS loading in Node)
	 */
	initMask() {
		if (this.maskReady !== null) return
		this.maskReady = (async () => {
			const { SimulatorMask } = await import('./mask/SimulatorMask')
			this.mask = new SimulatorMask()
		})()
	}
	// ======= State Queries =======

	/**
	 * Get current page URL
	 */
	async getCurrentUrl(): Promise<string> {
		return window.location.href
	}

	/**
	 * Get last tree update timestamp
	 */
	async getLastUpdateTime(): Promise<number> {
		return this.lastTimeUpdate
	}

	/**
	 * Get structured browser state for LLM consumption.
	 * Automatically calls updateTree() to refresh the DOM state.
	 */
	async getBrowserState(): Promise<BrowserState> {
		const url = window.location.href
		const title = document.title
		const pi = getPageInfo()
		const viewportExpansion = dom.resolveViewportExpansion(this.config.viewportExpansion)

		await this.updateTree()

		const content = this.simplifiedHTML

		// Build header: page info + scroll position hint
		const titleLine = `Current Page: [${title}](${url})`

		const pageInfoLine = `Page info: ${pi.viewport_width}x${pi.viewport_height}px viewport, ${pi.page_width}x${pi.page_height}px total page size, ${pi.pages_above.toFixed(1)} pages above, ${pi.pages_below.toFixed(1)} pages below, ${pi.total_pages.toFixed(1)} total pages, at ${(pi.current_page_position * 100).toFixed(0)}% of page`

		const elementsLabel =
			viewportExpansion === -1
				? 'Interactive elements from top layer of the current page (full page):'
				: 'Interactive elements from top layer of the current page inside the viewport:'

		const hasContentAbove = pi.pixels_above > 4
		const scrollHintAbove =
			hasContentAbove && viewportExpansion !== -1
				? `... ${pi.pixels_above} pixels above (${pi.pages_above.toFixed(1)} pages) - scroll to see more ...`
				: '[Start of page]'

		const header = `${titleLine}\n${pageInfoLine}\n\n${elementsLabel}\n\n${scrollHintAbove}`

		// Build footer: scroll position hint
		const hasContentBelow = pi.pixels_below > 4
		const footer =
			hasContentBelow && viewportExpansion !== -1
				? `... ${pi.pixels_below} pixels below (${pi.pages_below.toFixed(1)} pages) - scroll to see more ...`
				: '[End of page]'

		return { url, title, header, content, footer }
	}

	// ======= DOM Tree Operations =======

	/**
	 * Update DOM tree, returns simplified HTML for LLM.
	 * This is the main method to refresh the page state.
	 * Automatically bypasses mask during DOM extraction if enabled.
	 */
	async updateTree(): Promise<string> {
		this.dispatchEvent(new Event('beforeUpdate'))

		this.lastTimeUpdate = Date.now()

		// Temporarily bypass mask to allow DOM extraction
		if (this.mask) {
			this.mask.wrapper.style.pointerEvents = 'none'
		}

		dom.cleanUpHighlights()

		const blacklist = [
			...(this.config.interactiveBlacklist || []),
			...Array.from(document.querySelectorAll('[data-page-agent-not-interactive]')),
		]

		this.flatTree = dom.getFlatTree({
			...this.config,
			interactiveBlacklist: blacklist,
		})

		this.simplifiedHTML = dom.flatTreeToString(
			this.flatTree,
			this.config.includeAttributes,
			this.config.keepSemanticTags
		)

		this.selectorMap.clear()
		this.selectorMap = dom.getSelectorMap(this.flatTree)

		this.elementTextMap.clear()
		this.elementTextMap = dom.getElementTextMap(this.simplifiedHTML)

		// Mark as indexed - now element actions are allowed
		this.isIndexed = true

		// Restore mask blocking
		if (this.mask) {
			this.mask.wrapper.style.pointerEvents = 'auto'
		}

		this.dispatchEvent(new Event('afterUpdate'))

		return this.simplifiedHTML
	}

	/**
	 * Clean up all element highlights
	 */
	async cleanUpHighlights(): Promise<void> {
		console.log('[PageController] cleanUpHighlights')
		dom.cleanUpHighlights()
	}

	// ======= Element Actions =======

	/**
	 * Ensure the tree has been indexed before any index-based operation.
	 * Throws if updateTree() hasn't been called yet.
	 */
	private assertIndexed(): void {
		if (!this.isIndexed) {
			throw new Error('DOM tree not indexed yet. Can not perform actions on elements.')
		}
	}

	/**
	 * Print + buffer the xpath of the element the LLM just selected (by index).
	 * Called (and awaited) before every element action so each LLM selection is
	 * logged while the element is still alive in the DOM.
	 *
	 * When `enablePreciseXpath` is on and a `preciseXpathProvider` is injected,
	 * the record additionally carries a selector verified against the live DOM to
	 * select exactly this element; see `XPathStatus` for how to read the outcome.
	 * Rendering and verification live in ./xpathLog.
	 */
	private async logSelectedElement(
		action: string,
		index: number,
		element: HTMLElement | null,
		extra?: string
	): Promise<void> {
		const xpath = this.selectorMap.get(index)?.xpath
		if (!xpath) return
		const elementText = normalizeWhitespace(this.elementTextMap.get(index) ?? '').slice(0, 120)

		const entry: XPathLogEntry = {
			schemaVersion: XPATH_LOG_SCHEMA_VERSION,
			time: new Date().toLocaleTimeString(),
			action,
			index,
			xpath,
			elementText: elementText || undefined,
			...(extra ? { extra } : {}),
		}
		fillElementDetails(entry, element)

		if (this.config.enablePreciseXpath && element && this.config.preciseXpathProvider) {
			const verdict = await resolvePreciseXpath({
				element,
				xpath,
				provider: this.config.preciseXpathProvider,
				signal: this.taskAbortSignal,
			})
			entry.preciseXpath = verdict.xpath
			entry.preciseXpathStatus = verdict.status
			entry.preciseXpathIndex = verdict.index
			entry.preciseXpathMatchCount = verdict.matchCount
			entry.preciseXpathOffTarget = verdict.offTargetXpath
			// The one verdict worth shouting about: the generator answered with a
			// selector for a different node, so this element has no precise xpath.
			// The offending candidate is recorded in the entry either way.
			if (verdict.status === 'off-target') {
				console.warn(
					'[PageController] Discarded precise xpath candidate(s) selecting a different element ' +
						`than the selected one (raw_xpath=${xpath}, first_off_target=${verdict.offTargetXpath})`
				)
			}
		}

		console.log(formatSelectedElementLine(entry))
		this.xpathLog.push(entry)
	}

	/** Clear the buffered xpath log (e.g. before a new task starts). */
	clearXPathLog(): void {
		this.xpathLog = []
	}

	/**
	 * Export the xpath log accumulated during the current task as a brand new
	 * JSON Lines (`.jsonl`) file, one JSON object per selected element. The file
	 * is handed to the local log server first (`POST /logs`, see
	 * `scripts/flows-server.mjs`), which writes it into the project `logs/` dir —
	 * this works in any Chromium environment, including embedded desktop clients
	 * that have no download UI. When the server is unreachable, a real browser
	 * download of the file is used as a fallback.
	 *
	 * The buffered entries are only cleared once an export has succeeded, so a
	 * failed export keeps them for a later retry instead of dropping them.
	 * @returns Number of entries handed to a successful export; 0 when there is
	 * nothing to export or nothing could be persisted.
	 */
	async downloadXPathLog(filename = `page-agent-xpath-${Date.now()}.jsonl`): Promise<number> {
		const count = await exportXPathLog({
			entries: this.xpathLog,
			filename,
			serverUrl: this.config.xpathLogServerUrl,
		})
		// Only clear what was actually persisted, so a failed export can retry.
		if (count > 0) this.xpathLog = []
		return count
	}

	/**
	 * Click element by index
	 */
	async clickElement(index: number): Promise<ActionResult> {
		try {
			this.assertIndexed()
			const element = getElementByIndex(this.selectorMap, index)
			await this.logSelectedElement('click', index, element)
			const elemText = this.elementTextMap.get(index)
			await clickElement(element)

			// Handle links that open in new tabs
			if (isAnchorElement(element) && element.target === '_blank') {
				return {
					success: true,
					message: `✅ Clicked element (${elemText ?? index}). ⚠️ Link opened in a new tab.`,
				}
			}

			return {
				success: true,
				message: `✅ Clicked element (${elemText ?? index}).`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to click element: ${error}`,
			}
		}
	}

	/**
	 * Input text into element by index
	 */
	async inputText(index: number, text: string): Promise<ActionResult> {
		try {
			this.assertIndexed()
			const element = getElementByIndex(this.selectorMap, index)
			const isPasswordInput = element instanceof HTMLInputElement && element.type === 'password'
			const inputLog = isPasswordInput ? 'input=<redacted>' : `input=${text.slice(0, 120)}`
			await this.logSelectedElement('input_text', index, element, inputLog)
			const elemText = this.elementTextMap.get(index)
			await inputTextElement(element, text)

			return {
				success: true,
				message: `✅ Input text (${text}) into element (${elemText ?? index}).`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to input text: ${error}`,
			}
		}
	}

	/**
	 * Select dropdown option by index and option text
	 */
	async selectOption(index: number, optionText: string): Promise<ActionResult> {
		try {
			this.assertIndexed()
			const element = getElementByIndex(this.selectorMap, index)
			await this.logSelectedElement(
				'select_option',
				index,
				element,
				`option=${optionText.slice(0, 80)}`
			)
			const elemText = this.elementTextMap.get(index)
			await selectOptionElement(element as HTMLSelectElement, optionText)

			return {
				success: true,
				message: `✅ Selected option (${optionText}) in element (${elemText ?? index}).`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to select option: ${error}`,
			}
		}
	}

	/**
	 * Scroll vertically
	 */
	async scroll(options: {
		down: boolean
		numPages: number
		pixels?: number
		index?: number
	}): Promise<ActionResult> {
		try {
			const { down, numPages, pixels, index } = options

			this.assertIndexed()

			const scrollAmount = (pixels ?? numPages * window.innerHeight) * (down ? 1 : -1)

			const element = index !== undefined ? getElementByIndex(this.selectorMap, index) : null

			if (element) await this.logSelectedElement('scroll', index!, element)

			const message = await scrollVertically(scrollAmount, element)

			return {
				success: true,
				message,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to scroll: ${error}`,
			}
		}
	}

	/**
	 * Scroll horizontally
	 */
	async scrollHorizontally(options: {
		right: boolean
		pixels: number
		index?: number
	}): Promise<ActionResult> {
		try {
			const { right, pixels, index } = options

			this.assertIndexed()

			const scrollAmount = pixels * (right ? 1 : -1)

			const element = index !== undefined ? getElementByIndex(this.selectorMap, index) : null

			if (element) await this.logSelectedElement('scroll_horizontally', index!, element)

			const message = await scrollHorizontally(scrollAmount, element)

			return {
				success: true,
				message,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Failed to scroll horizontally: ${error}`,
			}
		}
	}

	/**
	 * Execute arbitrary JavaScript on the page.
	 * The optional `signal` is exposed to the script scope so cooperative code
	 * can abort promptly when the task is stopped.
	 */
	async executeJavascript(script: string, signal?: AbortSignal): Promise<ActionResult> {
		try {
			// Wrap script in async function to support await, exposing `signal`.
			const asyncFunction = eval(`(async (signal) => { ${script} })`)
			const result = await asyncFunction(signal)
			return {
				success: true,
				message: `✅ Executed JavaScript. Result: ${result}`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Error executing JavaScript: ${error}`,
			}
		}
	}

	// ======= Mask Operations =======

	/**
	 * Show the visual mask overlay.
	 * Only works after mask is setup.
	 */
	async showMask(): Promise<void> {
		await this.maskReady
		this.mask?.show()
	}

	/**
	 * Hide the visual mask overlay.
	 * Only works after mask is setup.
	 */
	async hideMask(): Promise<void> {
		await this.maskReady
		this.mask?.hide()
	}

	/**
	 * Dispose and clean up resources
	 */
	dispose(): void {
		dom.cleanUpHighlights()
		this.flatTree = null
		this.selectorMap.clear()
		this.elementTextMap.clear()
		this.simplifiedHTML = '<EMPTY>'
		this.isIndexed = false
		this.mask?.dispose()
		this.mask = null
	}
}

export * from './actions'
