import { afterEach, describe, expect, it } from 'vitest'

import { clickElement } from './actions'

/**
 * `clickElement()` synthesizes the whole event sequence itself; the only thing it
 * asks the browser for is the hit test. Stubbing that keeps these tests
 * deterministic, since happy-dom has no layout to hit-test against.
 */
function stubHitTest(element: Element | null): void {
	Object.defineProperty(document, 'elementFromPoint', {
		configurable: true,
		writable: true,
		value: () => element,
	})
}

interface IconButton {
	/** The wrapper an index usually resolves to; it owns no click listener. */
	wrapper: HTMLDivElement
	/** The element that actually owns the click handler, one level down. */
	box: HTMLDivElement
	/** The innermost element a real pointer would land on. */
	icon: SVGUseElement
	/** Click listeners in the order they fired. */
	clicks: string[]
}

/**
 * The shape that produced a dead click: a wrapper gets the index, the handler is
 * bound to an inner box, and the visible icon is an SVG `<use>` — an element
 * with no `click()` method of its own.
 */
function iconButton(): IconButton {
	const wrapper = document.createElement('div')
	const box = document.createElement('div')
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'use')
	svg.appendChild(icon)
	box.appendChild(svg)
	wrapper.appendChild(box)
	document.body.appendChild(wrapper)

	const clicks: string[] = []
	wrapper.addEventListener('click', () => clicks.push('wrapper'))
	box.addEventListener('click', () => clicks.push('box'))
	svg.addEventListener('click', () => clicks.push('svg'))
	return { wrapper, box, icon, clicks }
}

afterEach(() => {
	delete (document as { elementFromPoint?: unknown }).elementFromPoint
	document.body.innerHTML = ''
})

describe('clickElement', () => {
	it('reaches a listener bound to an inner element when the pointer lands on the SVG icon', async () => {
		const { wrapper, icon, clicks } = iconButton()
		stubHitTest(icon)

		await clickElement(wrapper)

		// The click travels the path a real one does: innermost element first, then
		// outward. Dispatching it on `wrapper` instead — the pre-fix behaviour —
		// fires only 'wrapper' and leaves the handler on the box untouched.
		expect(clicks).toEqual(['svg', 'box', 'wrapper'])
	})

	it('falls back to the resolved element when the hit test misses it', async () => {
		const { wrapper, clicks } = iconButton()
		const outsider = document.createElement('div')
		document.body.appendChild(outsider)
		stubHitTest(outsider)

		await clickElement(wrapper)

		expect(clicks).toEqual(['wrapper'])
	})

	it('propagates to shadow content when the host is the element under the pointer', async () => {
		const host = document.createElement('div')
		document.body.appendChild(host)
		const shadow = host.attachShadow({ mode: 'open' })
		shadow.innerHTML = '<div></div>'
		const inner = shadow.firstElementChild as HTMLDivElement

		let hits = 0
		inner.addEventListener('click', () => {
			hits++
		})

		// Browsers retarget shadow content to the host, and happy-dom implements no
		// hit testing at all, so both halves of the descent are stubbed here.
		Object.defineProperty(shadow, 'elementFromPoint', { configurable: true, value: () => inner })
		stubHitTest(host)

		await clickElement(host)

		expect(hits).toBe(1)
	})

	it('targets an SVG icon without an HTMLElement-only click() call', () => {
		const { icon } = iconButton()

		// The reason the SVG case cannot go through `element.click()`: browsers
		// leave `SVGElement.prototype.click` undefined, and so does happy-dom.
		expect(typeof (icon as unknown as { click?: unknown }).click).toBe('undefined')
	})
})
