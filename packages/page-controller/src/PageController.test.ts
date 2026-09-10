import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PageController } from './PageController'
import { getFlatTree } from './dom'
import type { FlatDomTree, InteractiveElementDomNode } from './dom/dom_tree/type'

describe('PageController', () => {
	it('constructs and exposes the current url', async () => {
		const controller = new PageController()
		expect(controller).toBeInstanceOf(PageController)
		expect(await controller.getCurrentUrl()).toBe(window.location.href)
	})

	describe('executeJavascript', () => {
		it('runs a script and returns its result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return 1 + 2')
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('3')
		})

		it('exposes the abort signal to the script scope', async () => {
			const controller = new PageController()
			const controllerSignal = new AbortController()
			controllerSignal.abort()

			const result = await controller.executeJavascript(
				'return signal.aborted',
				controllerSignal.signal
			)
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('true')
		})

		it('reports a syntax error as a failed result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return (')
			expect(result.success).toBe(false)
			expect(result.message).toContain('❌')
		})
	})
})

describe('PageController precise xpath verification', () => {
	let fetchBodies: string[] = []

	/**
	 * happy-dom has no layout engine, so every element measures 0x0 and the DOM
	 * tree drops it as invisible before it can be indexed. Give elements a box so
	 * the tree behaves like it does in a browser.
	 */
	const boxDescriptors = new Map(
		['offsetWidth', 'offsetHeight'].map((name) => [
			name,
			Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
		])
	)

	function stubElementBox(): void {
		for (const name of boxDescriptors.keys()) {
			Object.defineProperty(HTMLElement.prototype, name, {
				configurable: true,
				get: () => 100,
			})
		}
	}

	function restoreElementBox(): void {
		for (const [name, descriptor] of boxDescriptors) {
			if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
			else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
		}
	}

	/** The element the action targets, plus a second interactive element. */
	function appendElements(): { target: HTMLButtonElement; other: HTMLAnchorElement } {
		const target = document.createElement('button')
		target.textContent = 'Save'
		const other = document.createElement('a')
		other.setAttribute('href', '/elsewhere')
		other.textContent = 'Elsewhere'
		document.body.append(target, other)
		return { target, other }
	}

	/**
	 * Highlight index of `element`, computed the same way `updateTree()` does, so
	 * the test can drive the controller through its public index-based API.
	 */
	function highlightIndexOf(element: HTMLElement): number {
		const tree = getFlatTree({}) as FlatDomTree
		const node = Object.values(tree.map).find(
			(candidate) => (candidate as InteractiveElementDomNode).ref === element
		) as InteractiveElementDomNode | undefined
		if (!node) throw new Error('element was not indexed as interactive')
		return node.highlightIndex
	}

	/** Stand-in for the browser XPath engine, which happy-dom does not implement. */
	function stubXpathEngine(matches: Record<string, Node[]>): void {
		;(document as unknown as { evaluate: unknown }).evaluate = vi.fn((expression: string) => {
			const nodes = matches[expression] ?? []
			return { snapshotLength: nodes.length, snapshotItem: (i: number) => nodes[i] ?? null }
		})
	}

	/** Capture what downloadXPathLog() would POST to the log server. */
	function stubLogServer(): void {
		fetchBodies = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: { body: string }) => {
				fetchBodies.push(init.body)
				return { ok: true, status: 200 }
			})
		)
	}

	/** Run one selection through the controller and return the logged entry. */
	async function selectTarget(
		element: HTMLElement,
		candidates: string[] | null,
		matches: Record<string, Node[]> = {}
	): Promise<Record<string, unknown>> {
		stubXpathEngine(matches)
		stubLogServer()
		const controller = new PageController({
			enablePreciseXpath: true,
			preciseXpathProvider: async () => candidates,
		})
		await controller.updateTree()
		await controller.clickElement(highlightIndexOf(element))
		expect(await controller.downloadXPathLog('test.jsonl')).toBe(1)
		const posted = JSON.parse(fetchBodies[0]) as { content: string }
		const [entry] = posted.content
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		return entry as Record<string, unknown>
	}

	/** The `precise_xpath_*` part of the console line the selection printed. */
	function consoleLine(log: { mock: { calls: unknown[][] } }): string {
		return (
			log.mock.calls
				.map((call) => String(call[0]))
				.find((candidate) => candidate.includes('LLM selected element')) ?? ''
		)
	}

	beforeEach(stubElementBox)

	afterEach(() => {
		restoreElementBox()
		document.body.innerHTML = ''
		delete (document as unknown as { evaluate?: unknown }).evaluate
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('logs a candidate that selects exactly the selected element', async () => {
		const { target } = appendElements()
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})

		const entry = await selectTarget(target, ["//button[.='Save']"], {
			"//button[.='Save']": [target],
		})

		expect(entry.preciseXpath).toBe("//button[.='Save']")
		expect(entry.preciseXpathStatus).toBe('attribute')
		expect(entry.preciseXpathOffTarget).toBeUndefined()
		const line = consoleLine(log)
		expect(line).toContain('precise_xpath_status=attribute')
		expect(line).toContain("precise_xpath=//button[.='Save']")
	})

	it('drops a candidate that is unique but selects a different element', async () => {
		const { target, other } = appendElements()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		const entry = await selectTarget(target, ["//a[@href='/elsewhere']"], {
			"//a[@href='/elsewhere']": [other],
		})

		// The regression this guards: that candidate *is* unique, so a
		// uniqueness-only check used to log it as the selected element's xpath.
		// A position cannot rescue it either: it does not contain the element.
		expect(entry.preciseXpath).toBeUndefined()
		expect(entry.preciseXpathStatus).toBe('off-target')
		// The offending candidate stays in the record, so the log alone shows the
		// generator answered for a different node.
		expect(entry.preciseXpathOffTarget).toBe("//a[@href='/elsewhere']")
		const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n')
		expect(warnings).toContain("first_off_target=//a[@href='/elsewhere']")
	})

	it('disambiguates an ambiguous candidate by document-order position', async () => {
		const { target, other } = appendElements()
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})

		const entry = await selectTarget(target, ['//button'], { '//button': [target, other] })

		// `//button` alone matches two nodes, so the position is part of the
		// selector — the same shape the hand-written page objects use.
		expect(entry.preciseXpath).toBe('(//button)[1]')
		expect(entry.preciseXpathStatus).toBe('positional')
		expect(entry.preciseXpathIndex).toBe(1)
		expect(entry.preciseXpathMatchCount).toBe(2)
		const line = consoleLine(log)
		expect(line).toContain('precise_xpath_status=positional match_count=2')
		expect(line).toContain('precise_xpath=(//button)[1]')
	})

	it('prefers an unambiguous candidate over a positional one', async () => {
		const { target, other } = appendElements()

		const entry = await selectTarget(target, ['//button', "//button[.='Save']"], {
			'//button': [target, other],
			"//button[.='Save']": [target],
		})

		expect(entry.preciseXpath).toBe("//button[.='Save']")
		expect(entry.preciseXpathStatus).toBe('attribute')
	})

	it('names the reason when no candidate contains the element', async () => {
		const { target, other } = appendElements()

		const entry = await selectTarget(target, ['//input', '//a'], {
			'//input': [],
			'//a': [other, other],
		})

		expect(entry.preciseXpath).toBeUndefined()
		expect(entry.preciseXpathStatus).toBe('no-match')
		expect(entry.xpath).toBeTruthy()
	})

	it('separates "the generator did not run" from "the page had no match"', async () => {
		const { target } = appendElements()

		// `null` is the provider saying it never asked the LLM (disabled, aborted,
		// failed) — a reader of the log must not read that as a DOM verdict.
		const entry = await selectTarget(target, null)

		expect(entry.preciseXpath).toBeUndefined()
		expect(entry.preciseXpathStatus).toBe('not-generated')
	})

	it('records the schema version on every entry', async () => {
		const { target } = appendElements()

		const entry = await selectTarget(target, ["//button[.='Save']"], {
			"//button[.='Save']": [target],
		})

		expect(entry.schemaVersion).toBe(1)
	})
})
