import { describe, expect, it, vi } from 'vitest'

import { type XPathMatch, findXPathForNode } from './xpathVerify'

/** The element the action targeted. */
const target = { name: 'target' }

/** A different element that is easy to confuse with it. */
const other = { name: 'other' }

/** Matcher backed by a `{ xpath: matched nodes }` table; unknown xpaths throw. */
function matcherFrom(table: Record<string, object[]>) {
	return vi.fn((xpath: string): XPathMatch<object> => {
		const nodes = table[xpath]
		if (!nodes) throw new Error('invalid xpath')
		return { count: nodes.length, nodeAt: (index: number) => nodes[index] }
	})
}

describe('findXPathForNode', () => {
	it('accepts a candidate that selects the targeted node on its own', () => {
		const match = matcherFrom({
			'//ambiguous': [target, other],
			'//unique': [target],
			'//never evaluated': [target],
		})

		expect(
			findXPathForNode(['//ambiguous', '//unique', '//never evaluated'], match, target)
		).toEqual({
			status: 'attribute',
			xpath: '//unique',
		})
		// The attribute tier beats the earlier ambiguous candidate, and nothing
		// after the winner is evaluated.
		expect(match).toHaveBeenCalledTimes(2)
	})

	it('falls back to the document-order position when no candidate is unambiguous', () => {
		const match = matcherFrom({ '//row': [other, other, target, other, other] })

		expect(findXPathForNode(['//row'], match, target)).toEqual({
			status: 'positional',
			xpath: '(//row)[3]',
			index: 3,
			matchCount: 5,
		})
	})

	it('keeps the position when the target is the first match of an ambiguous base', () => {
		// `//row` alone selects two nodes, so dropping the position would report a
		// selector that is not unique at all.
		const match = matcherFrom({ '//row': [target, other] })

		expect(findXPathForNode(['//row'], match, target)).toEqual({
			status: 'positional',
			xpath: '(//row)[1]',
			index: 1,
			matchCount: 2,
		})
	})

	it('prefers the narrowest ambiguous candidate', () => {
		const match = matcherFrom({
			'//wide': [other, other, other, other, target],
			'//narrow': [other, target],
		})

		expect(findXPathForNode(['//wide', '//narrow'], match, target)).toEqual({
			status: 'positional',
			xpath: '(//narrow)[2]',
			index: 2,
			matchCount: 2,
		})
		expect(match).toHaveBeenCalledTimes(2) // every candidate must be measured
	})

	it('keeps model order between equally wide candidates', () => {
		const match = matcherFrom({
			'//first': [other, target],
			'//second': [other, target],
		})

		expect(findXPathForNode(['//first', '//second'], match, target)).toMatchObject({
			xpath: '(//first)[2]',
			matchCount: 2,
		})
	})

	it('reports a candidate that is unique but selects a different element', () => {
		// The case a uniqueness-only check cannot see: this candidate is a
		// perfectly unique xpath — for the wrong element. It cannot be salvaged
		// with a position either, because it does not contain the target.
		const match = matcherFrom({ "//button[@type='submit']": [other] })

		expect(findXPathForNode(["//button[@type='submit']"], match, target)).toEqual({
			status: 'off-target',
			offTargetXpath: "//button[@type='submit']",
		})
	})

	it('reports an ambiguous candidate that does not contain the target', () => {
		const match = matcherFrom({ '//rows': [other, other] })

		expect(findXPathForNode(['//rows'], match, target)).toEqual({ status: 'no-match' })
	})

	it('records an off-target candidate next to the accepted one', () => {
		// The accepted selector is usable, but the wrong candidate is kept as
		// evidence that the generator answered for a different node.
		const match = matcherFrom({ "//wrong[@id='x']": [other], '//right': [target] })

		expect(findXPathForNode(["//wrong[@id='x']", '//right'], match, target)).toEqual({
			status: 'attribute',
			xpath: '//right',
			offTargetXpath: "//wrong[@id='x']",
		})
	})

	it('skips invalid xpaths, empty matches and keeps looking', () => {
		const match = vi.fn((xpath: string): XPathMatch<object> => {
			if (xpath === '//broken[') throw new Error('invalid xpath')
			if (xpath === '//nothing') return { count: 0, nodeAt: () => undefined }
			return { count: 1, nodeAt: () => target }
		})

		expect(
			findXPathForNode(['//broken[', '//nothing', "//button[.='确认']"], match, target)
		).toEqual({
			status: 'attribute',
			xpath: "//button[.='确认']",
		})
	})

	it('skips blank and non-string candidates', () => {
		const match = vi.fn((_xpath: string): XPathMatch<object> => ({
			count: 1,
			nodeAt: () => target,
		}))

		expect(findXPathForNode(['  ', '', 42, null, "//button[.='Go']"], match, target)).toMatchObject(
			{
				status: 'attribute',
				xpath: "//button[.='Go']",
			}
		)
		expect(match).toHaveBeenCalledTimes(1)
	})

	it('distinguishes "nothing to evaluate" from "nothing matched"', () => {
		// A reader of the log acts on this difference: `no-candidates` is a
		// generator problem, `no-match` a page problem.
		const match = matcherFrom({ '//a': [], '//b': [other, other] })

		expect(findXPathForNode([], match, target)).toEqual({ status: 'no-candidates' })
		expect(findXPathForNode(['   ', 42, null], match, target)).toEqual({ status: 'no-candidates' })
		expect(findXPathForNode(['//a', '//b'], match, target)).toEqual({ status: 'no-match' })
	})
})
