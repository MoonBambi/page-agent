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

interface HoverMenu {
	/** The element an index resolves to: an outer wrapper that owns no listener. */
	wrapper: HTMLDivElement
	/** The trigger, shaped like el-dropdown's `.el-dropdown-selfdefine`: it owns the listeners. */
	trigger: HTMLDivElement
	/** The innermost element a real pointer would land on. */
	label: HTMLSpanElement
	/** Elements that received `mouseenter`, in firing order. */
	entered: string[]
	/** Whether each element's own `mouseenter` listener saw itself as `event.target`. */
	selfTargets: [string, boolean][]
	/** Elements that received `mouseleave`, in firing order. */
	left: string[]
}

/**
 * The shape behind hover-triggered menus: the index resolves to the outer wrapper,
 * the component binds `mouseenter`/`mouseleave` to the trigger inside it, and the
 * innermost element under the pointer is a span inside that trigger.
 *
 * Both halves matter. `mouseenter` dispatched at the span alone does not bubble,
 * so the trigger never hears the pointer and the menu never opens; and
 * `mouseleave` dispatched at the wrapper is not watched by the trigger, so a menu
 * that did open never closes.
 */
function hoverMenu(): HoverMenu {
	const wrapper = document.createElement('div')
	const trigger = document.createElement('div')
	trigger.className = 'el-dropdown-selfdefine'
	const label = document.createElement('span')
	label.textContent = 'Resources'
	trigger.appendChild(label)
	wrapper.appendChild(trigger)
	document.body.appendChild(wrapper)

	const entered: string[] = []
	const selfTargets: [string, boolean][] = []
	const left: string[] = []

	trigger.addEventListener('mouseenter', (event) => {
		entered.push('trigger')
		selfTargets.push(['trigger', event.target === trigger])
	})
	label.addEventListener('mouseenter', (event) => {
		entered.push('label')
		selfTargets.push(['label', event.target === label])
	})
	trigger.addEventListener('mouseleave', () => left.push('trigger'))
	label.addEventListener('mouseleave', () => left.push('label'))

	return { wrapper, trigger, label, entered, selfTargets, left }
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

describe('hover events on a hover-triggered menu', () => {
	it('reaches a trigger that binds mouseenter above the element under the pointer', async () => {
		const { wrapper, label, entered } = hoverMenu()
		stubHitTest(label)

		await clickElement(wrapper)

		// Pre-fix only 'label' appeared: `mouseenter` does not bubble, so a listener
		// on the trigger above it never fired. Outermost first is this
		// implementation's choice of an order the spec leaves unspecified.
		expect(entered).toEqual(['trigger', 'label'])
	})

	it('gives every entered element an event whose target is that element', async () => {
		const { wrapper, label, selfTargets } = hoverMenu()
		stubHitTest(label)

		await clickElement(wrapper)

		// A single bubbling event would hand both listeners `label` as
		// `event.target`, which is what breaks a listener comparing it against itself.
		expect(selfTargets).toEqual([
			['trigger', true],
			['label', true],
		])
	})

	it('closes the previous menu by dispatching leave back down the entered path', async () => {
		const { wrapper, label, left } = hoverMenu()
		stubHitTest(label)
		await clickElement(wrapper)

		const other = document.createElement('div')
		document.body.appendChild(other)
		stubHitTest(other)
		await clickElement(other)

		// Pre-fix `mouseleave` was dispatched at the wrapper only — the trigger was
		// never told, so the menu it opened stayed open. Innermost first, mirroring
		// the enter order.
		expect(left).toEqual(['label', 'trigger'])
	})

	it('climbs out of an open shadow root to reach a trigger outside it', async () => {
		const host = document.createElement('div')
		document.body.appendChild(host)
		const shadow = host.attachShadow({ mode: 'open' })
		shadow.innerHTML = '<div><span></span></div>'
		const inner = shadow.querySelector('span')!

		const entered: string[] = []
		host.addEventListener('mouseenter', () => entered.push('host'))
		inner.addEventListener('mouseenter', () => entered.push('inner'))

		// Browsers retarget shadow content to the host, and happy-dom implements no
		// hit testing at all, so both halves of the descent are stubbed here. The
		// walk back out has to go through the host, since boundary events are not
		// composed and `parentElement` is null at the shadow root.
		Object.defineProperty(shadow, 'elementFromPoint', { configurable: true, value: () => inner })
		stubHitTest(host)

		await clickElement(host)

		expect(entered).toEqual(['host', 'inner'])
	})
})
