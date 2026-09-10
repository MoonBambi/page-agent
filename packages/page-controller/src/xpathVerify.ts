/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 *
 * Verification of candidate precise xpaths against the live DOM.
 * Kept free of DOM access so the decision logic can be unit tested directly.
 */

/**
 * Why an element has, or has not, a verified precise xpath.
 *
 * This is the single field a log consumer switches on: `attribute` and
 * `positional` come with a usable selector, every other value names the step
 * that failed, so the log never has to be read together with the console.
 */
export type XPathStatus =
	/** A candidate selects the targeted element on its own — no position in it to go stale. */
	| 'attribute'
	/** No candidate was unambiguous, so the narrowest one containing the element was narrowed by document-order position (`(base)[n]`). */
	| 'positional'
	/** A candidate was unique, but selected a *different* element: the generator aimed at the wrong node. */
	| 'off-target'
	/** Candidates were evaluated, but none selected the targeted element. */
	| 'no-match'
	/** The generator ran, but produced nothing that could be evaluated. */
	| 'no-candidates'
	/** Generation did not run: disabled, aborted, failed, or no XPath engine to verify with. */
	| 'not-generated'

/** How one candidate xpath matched the live DOM. */
export interface XPathMatch<TNode> {
	/** Number of nodes the candidate selected. */
	count: number
	/**
	 * The selected node at `index` (0-based); `undefined` when out of range.
	 *
	 * Lazy on purpose: verification walks the match set only as far as it must,
	 * so a candidate matching thousands of nodes costs no more than the search
	 * for the target inside it.
	 */
	nodeAt: (index: number) => TNode | undefined
}

/** Verdict of a candidate list against the live DOM. */
export interface XPathVerdict {
	/** What the live check concluded; see XPathStatus. */
	status: XPathStatus
	/**
	 * The accepted selector, present for `attribute` and `positional` only. It
	 * selects exactly one node in the live DOM, and that node is the one the
	 * action targeted.
	 *
	 * A `positional` selector is correct *now*: its position was read off the
	 * live match set, not guessed. It drifts when the match set changes ahead of
	 * the element, which is why `index` and `matchCount` say how much slack it has.
	 */
	xpath?: string
	/** 1-based document-order position used in the selector (`positional` only). */
	index?: number
	/** Size of the base match set the position was taken from (`positional` only). */
	matchCount?: number
	/**
	 * The first candidate that selected exactly one node *other* than the
	 * targeted one. Recorded whenever it is seen, even when another candidate was
	 * accepted: it is evidence that the generator answered with a selector for a
	 * different node, which a uniqueness-only check cannot see.
	 */
	offTargetXpath?: string
}

/**
 * Find the candidate that selects `node` in the live DOM, best tier first.
 *
 * 1. A candidate that selects exactly the targeted node wins immediately: it
 *    needs no position, so it survives the match set being reshuffled. Later
 *    candidates are not even evaluated.
 * 2. Otherwise the least ambiguous candidate that *contains* the node is used,
 *    with its document-order position appended (`(base)[n]`). A narrower match
 *    set is preferred because it drifts less: a smaller set has fewer elements
 *    that can be inserted ahead of the target.
 *
 * Uniqueness alone is never enough to accept a candidate: an attribute-based
 * xpath that matches a single node somewhere else in the page is a wrong answer,
 * and a uniqueness-only check cannot tell it apart from a right one — every
 * candidate is compared against the node the action targeted.
 *
 * Candidates that match nothing, or that do not contain the target, are skipped
 * rather than treated as errors; the returned status says which of the outcomes
 * above happened, so callers do not have to infer it from a missing field.
 *
 * @param candidates - Candidate xpaths, most preferred first.
 * @param match - Live-DOM matcher: which nodes the candidate selected. Should
 *   throw for an invalid xpath.
 * @param node - The node the action targeted; a candidate is accepted only when
 *   it selects this node.
 */
export function findXPathForNode<TNode>(
	candidates: readonly unknown[],
	match: (xpath: string) => XPathMatch<TNode>,
	node: TNode
): XPathVerdict {
	let evaluated = 0
	let offTargetXpath: string | undefined
	let positional: { value: string; index: number; matchCount: number } | undefined

	for (const candidate of candidates) {
		if (typeof candidate !== 'string' || !candidate.trim()) continue
		const value = candidate.trim()

		let result: XPathMatch<TNode>
		try {
			result = match(value)
		} catch {
			continue // invalid xpath from the model: try the next candidate
		}
		evaluated++
		if (result.count <= 0) continue

		if (result.count === 1) {
			if (result.nodeAt(0) === node) {
				return { status: 'attribute', xpath: value, offTargetXpath }
			}
			offTargetXpath ??= value
			continue
		}

		// Ambiguous: usable only if it contains the target, and then only as the
		// narrowest such candidate.
		const position = indexOfNode(result, node)
		if (position < 0) continue
		if (!positional || result.count < positional.matchCount) {
			positional = { value, index: position + 1, matchCount: result.count }
		}
	}

	if (positional) {
		// A base matching several nodes is never unambiguous on its own, so it
		// always carries its position.
		return {
			status: 'positional',
			xpath: `(${positional.value})[${positional.index}]`,
			index: positional.index,
			matchCount: positional.matchCount,
			offTargetXpath,
		}
	}
	if (offTargetXpath) return { status: 'off-target', offTargetXpath }
	if (evaluated > 0) return { status: 'no-match' }
	return { status: 'no-candidates' }
}

/** 0-based position of `node` in a match set, or -1 when it is not in it. */
function indexOfNode<TNode>(match: XPathMatch<TNode>, node: TNode): number {
	for (let index = 0; index < match.count; index++) {
		if (match.nodeAt(index) === node) return index
	}
	return -1
}
