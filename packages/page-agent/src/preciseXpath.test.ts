import type { InvokeResult, LLM } from '@page-agent/llms'
import type { XPathSnapshot } from '@page-agent/page-controller'
import { describe, expect, it, vi } from 'vitest'

import { createPreciseXpathGenerator } from './preciseXpath'

/** Minimal snapshot; the generator only forwards it to the LLM. */
const snapshot: XPathSnapshot = {
	rawXpath: 'html/body/form/button',
	tagName: 'button',
	attributes: { type: 'button' },
	outerHTML: '<button type="button">Save</button>',
	text: 'Save',
	ancestors: [],
}

/** A generator whose LLM is a spy, so no endpoint is ever contacted. */
function makeGenerator(invoke: (attempt: number) => Promise<InvokeResult>) {
	// `mock.calls` already holds the running call, so `attempt` is 1-based.
	const spy = vi.fn((..._args: unknown[]) => invoke(spy.mock.calls.length))
	const generator = createPreciseXpathGenerator({
		config: { baseURL: 'https://example.test', model: 'test-model', apiKey: 'k' },
		createLlm: () => ({ invoke: spy }) as unknown as LLM,
	})
	return { generator, spy }
}

/** One successful invocation returning the given candidates. */
function resolved(candidates: unknown[]): InvokeResult {
	return { toolResult: candidates } as unknown as InvokeResult
}

/** An error carrying the name that distinguishes cancellation from failure. */
function abortError(): Error {
	const error = new Error('aborted')
	error.name = 'AbortError'
	return error
}

describe('createPreciseXpathGenerator', () => {
	it('returns the sanitized candidates the model produced', async () => {
		const { generator } = makeGenerator(async () =>
			resolved(["//*[@id='app']//input", "//input[@placeholder='q']"])
		)

		// The id-based candidate is dropped here; PageController never sees it.
		expect(await generator.provider(snapshot)).toEqual(["//input[@placeholder='q']"])
	})

	it('reports that it did not run instead of reporting no candidates', async () => {
		// `null` and `[]` mean different things to a reader of the log, and the
		// controller turns them into different statuses.
		const { generator } = makeGenerator(async () => resolved([]))

		expect(await generator.provider(snapshot)).toEqual([])

		const controller = new AbortController()
		controller.abort()
		expect(await generator.provider(snapshot, controller.signal)).toBeNull()
	})

	it('treats a cancelled call as cancellation, not as a failure', async () => {
		const { generator, spy } = makeGenerator(async (attempt) => {
			if (attempt === 1) throw abortError()
			throw new Error('boom')
		})

		expect(await generator.provider(snapshot)).toBeNull()
		// Two failures follow the abort, so the budget is not spent yet.
		expect(await generator.provider(snapshot)).toBeNull()
		expect(await generator.provider(snapshot)).toBeNull()
		expect(await generator.provider(snapshot)).toBeNull()
		expect(spy).toHaveBeenCalledTimes(4)
	})

	it('stops calling the LLM after three consecutive failures', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { generator, spy } = makeGenerator(async () => {
			throw new Error('boom')
		})

		await generator.provider(snapshot)
		await generator.provider(snapshot)
		await generator.provider(snapshot)
		expect(spy).toHaveBeenCalledTimes(3)

		// Fourth selection: no request, and the caller is told generation did not
		// run rather than that the page had no match.
		expect(await generator.provider(snapshot)).toBeNull()
		expect(spy).toHaveBeenCalledTimes(3)
		expect(warn.mock.calls.map((call) => String(call[1])).join('\n')).toContain('boom')
	})

	it('re-arms the failure budget on reset', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { generator, spy } = makeGenerator(async () => {
			throw new Error('boom')
		})

		for (let i = 0; i < 4; i++) await generator.provider(snapshot)
		expect(spy).toHaveBeenCalledTimes(3)

		// A new task gets a new budget: the endpoint may be fixed by then.
		generator.reset()
		await generator.provider(snapshot)
		expect(spy).toHaveBeenCalledTimes(4)
	})

	it('forgets earlier failures once a call succeeds', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { generator, spy } = makeGenerator(async (attempt) =>
			attempt === 3 ? resolved(['//button']) : Promise.reject(new Error('boom'))
		)

		await generator.provider(snapshot)
		await generator.provider(snapshot)
		// The third call succeeds, which restarts the counter...
		expect(await generator.provider(snapshot)).toEqual(['//button'])

		// ...so it takes three *further* failures to give up, not one.
		await generator.provider(snapshot)
		await generator.provider(snapshot)
		await generator.provider(snapshot)
		expect(spy).toHaveBeenCalledTimes(6)
		await generator.provider(snapshot)
		expect(spy).toHaveBeenCalledTimes(6)
	})
})
