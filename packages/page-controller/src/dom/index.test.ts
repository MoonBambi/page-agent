import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FlatDomTree } from './dom_tree/type'
import { flatTreeToString, getFlatTree } from './index'

/**
 * What the LLM is told about a checkbox the page draws itself.
 *
 * The regression these tests guard: a styled checkbox is a 0x0 native input
 * next to artwork. The input is dropped as invisible, the label that is indexed
 * carries no state, and the browser state shows a checked box exactly like an
 * unchecked one — so an agent asked to "click it only if it is unchecked"
 * clicks it, toggling the state it was told to leave alone.
 */
describe('hidden control state', () => {
	/**
	 * happy-dom has no layout engine, so every element measures 0x0 and the tree
	 * drops it as invisible. Give elements a box, then take it away from the
	 * controls that pages hide with CSS.
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

	/** `width: 0; height: 0` in CSS, as element-ui's `.el-checkbox__original` is. */
	function collapse(element: HTMLElement): void {
		for (const name of boxDescriptors.keys()) {
			Object.defineProperty(element, name, { configurable: true, get: () => 0 })
		}
	}

	function simplifiedHTML(): string {
		return flatTreeToString(getFlatTree({}) as FlatDomTree)
	}

	/** The line the LLM sees for the element carrying `text`. */
	function lineWith(text: string): string {
		const line = simplifiedHTML()
			.split('\n')
			.find((candidate) => candidate.includes(text))
		if (line === undefined) throw new Error(`no element line containing "${text}"`)
		return line
	}

	/** element-ui: the label wraps a 0x0 input, and the state lives in a class. */
	function renderElementUiCheckbox(checked: boolean, type = 'checkbox'): void {
		document.body.innerHTML = `
			<label class="el-checkbox ${checked ? 'is-checked' : ''}">
				<span class="el-checkbox__input ${checked ? 'is-checked' : ''}">
					<input type="${type}" class="el-checkbox__original" />
					<span class="el-checkbox__inner"></span>
				</span>
				<span class="el-checkbox__label">备选项</span>
			</label>
		`
		const input = document.querySelector('input')!
		input.checked = checked
		collapse(input)
	}

	beforeEach(stubElementBox)

	afterEach(() => {
		for (const [name, descriptor] of boxDescriptors) {
			if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
			else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
		}
		document.body.innerHTML = ''
	})

	it('exposes the checked state of an element-ui style checkbox', () => {
		renderElementUiCheckbox(true)
		expect(lineWith('备选项')).toContain('type=checkbox checked=true')
	})

	it('keeps checked and unchecked distinguishable', () => {
		renderElementUiCheckbox(true)
		const checked = simplifiedHTML()

		document.body.innerHTML = ''
		renderElementUiCheckbox(false)
		const unchecked = simplifiedHTML()

		expect(unchecked).toContain('checked=false')
		expect(unchecked).not.toBe(checked)
	})

	it('exposes radio state the same way', () => {
		renderElementUiCheckbox(true, 'radio')
		expect(lineWith('备选项')).toContain('type=radio checked=true')
	})

	it('follows an explicit for= association to a hidden control', () => {
		document.body.innerHTML = `
			<input type="checkbox" id="agree" checked />
			<label for="agree">同意</label>
		`
		collapse(document.querySelector('input')!)

		expect(lineWith('同意')).toContain('type=checkbox checked=true')
	})

	it('leaves the label alone when the control is listed itself', () => {
		document.body.innerHTML = `
			<input type="checkbox" id="plain" checked />
			<label for="plain">备选项</label>
		`

		expect(lineWith('id=plain')).toContain('checked=true')
		expect(lineWith('备选项')).not.toContain('type=')
	})

	it('ignores input type=hidden, which no label is associated with', () => {
		document.body.innerHTML = `
			<label class="wrapper">
				<input type="hidden" name="token" value="abc" />
				<span>备选项</span>
			</label>
		`

		expect(lineWith('备选项')).not.toContain('token')
	})
})
