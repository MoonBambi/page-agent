/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 *
 * Generator of candidate precise xpaths.
 *
 * It lives in the agent layer because it calls an LLM: PageController stays
 * LLM-free and only verifies what this returns against the live DOM. It is kept
 * out of PageAgent so both halves can be tested without a running agent, and so
 * the agent class stays an entry point rather than a home for prompt text.
 */
import { LLM, type LLMConfig, mergeLLMConfig } from '@page-agent/llms'
import type { XPathCandidateProvider, XPathSnapshot } from '@page-agent/page-controller'
import * as z from 'zod/v4'

import { sanitizeXpathCandidates } from './xpathCandidates'

/** Name of the forced tool used for precise-xpath generation. */
const TOOL_NAME = 'precise_xpath'

/** Structured output: an ordered list of candidate precise xpaths. */
const SCHEMA = z.object({
	candidates: z.array(z.string()).min(1).max(5),
})

/** After this many consecutive failures the generator stops calling the LLM. */
const MAX_CONSECUTIVE_FAILURES = 3

const SYSTEM_PROMPT = [
	'You convert a snapshot of a selected DOM element into several precise, attribute-based absolute XPath expressions that locate the same element.',
	'Rules:',
	'- Output 3-5 candidates ordered by expected robustness (most preferred first).',
	"- Prefer stable, meaningful attributes: name, data-testid, data-*, aria-*, then class, type, placeholder. Combine conditions with 'and', e.g. //input[@class='el-input__inner' and @placeholder='搜索应用'].",
	'- NEVER use the id attribute: no @id="...", no [@id], no contains(@id, ...). Ids are generated per render and break on the next page load. When an element seems to be identifiable only by its id, rebuild the path from its name/placeholder/type/text or from a distinguishing ancestor instead — id-based candidates are discarded before verification.',
	'- Build absolute paths starting from anywhere in the document (//...); avoid positional indices like [2] unless unavoidable.',
	"- If the element's own attributes cannot make it unique, anchor the path inside a distinguishing ancestor from the snapshot (e.g. the visible dialog or table row), guarding against hidden containers, e.g. //div[contains(@class,'dialog') and not(contains(@style,'display: none'))]//button[.='确认'].",
	'- Text may be any language: match placeholder/title attributes or text via contains(.) / normalize-space().',
	'- Never invent attribute values or text: only use what is present in the snapshot.',
	'- Do not echo the raw positional path; always produce attribute-based paths.',
].join('\n')

export interface PreciseXpathGeneratorOptions {
	/** The agent's LLM settings, inherited unless `overrides` changes them. */
	config: LLMConfig
	/** Settings for this generator only (see `PageAgentConfig.auxLlm`). */
	overrides?: Partial<LLMConfig>
	/** Creates the LLM client; injected in tests. Defaults to the merged config. */
	createLlm?: () => LLM
}

export interface PreciseXpathGenerator {
	/**
	 * Generate candidates for one selection; see `XPathCandidateProvider` for the
	 * meaning of the return value. Cancelled work is not a failure.
	 */
	provider: XPathCandidateProvider
	/**
	 * Give the generator a fresh failure budget. Called once per task, so a task
	 * that ran into a broken endpoint does not disable generation for the next one.
	 */
	reset: () => void
}

/**
 * Build the default precise-xpath generator.
 *
 * Candidates are only *generated* here — each one is verified by PageController
 * against the live DOM, which accepts it only when it selects exactly one node
 * and that node is the selected element. Repeated failures stop the LLM calls
 * until the next task, which is what keeps a broken endpoint from costing one
 * failed request per selection.
 *
 * @note This generator sends its own system prompt, so it requires an endpoint
 * that lets the caller choose the prompt. The shared page-agent demo proxy does
 * not: it answers `403 {"error":"Invalid request","message":"System prompt must
 * match the official page-agent system prompt."}`. Use your own `baseURL`/`apiKey`
 * (or inject a custom `preciseXpathProvider`) when enabling `enablePreciseXpath`.
 */
export function createPreciseXpathGenerator(
	options: PreciseXpathGeneratorOptions
): PreciseXpathGenerator {
	const { config, overrides, createLlm } = options
	// Auxiliary work: inherit the agent's LLM settings unless `auxLlm` overrides them.
	const auxConfig = mergeLLMConfig(config, overrides)
	let llm: LLM | null = null
	let consecutiveFailures = 0
	let stopped = false

	function fail(reason: string): null {
		consecutiveFailures++
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			stopped = true
			console.warn(
				`[PageAgent] Precise xpath generation disabled until the next task, after ` +
					`${consecutiveFailures} consecutive failures. Last error: ${reason}`
			)
		} else {
			console.warn('[PageAgent] Precise xpath generation failed:', reason)
		}
		return null
	}

	return {
		async provider(snapshot: XPathSnapshot, signal?: AbortSignal): Promise<string[] | null> {
			// `stopped` is reported through the return value, not by throwing: the
			// log must not read a disabled generator as a page with no match.
			if (stopped || signal?.aborted) return null
			try {
				llm ??= createLlm ? createLlm() : new LLM(auxConfig)
				const result = await llm.invoke(
					[
						{ role: 'system', content: SYSTEM_PROMPT },
						{ role: 'user', content: JSON.stringify(snapshot) },
					],
					{
						[TOOL_NAME]: {
							description: 'Output candidate precise xpath expressions for the given element.',
							inputSchema: SCHEMA,
							execute: async (args: { candidates: string[] }) => args.candidates,
						},
					},
					// The task signal cancels this call; a fresh (never aborted) signal
					// keeps the generator usable outside a task, e.g. in tests.
					signal ?? new AbortController().signal,
					{ toolChoiceName: TOOL_NAME }
				)

				const raw = Array.isArray(result.toolResult) ? (result.toolResult as unknown[]) : []
				const { candidates, droppedForId } = sanitizeXpathCandidates(raw)
				if (droppedForId > 0) {
					console.debug(
						`[PageAgent] Ignored ${droppedForId} precise-xpath candidate(s) that rely on @id ` +
							'(ids are not stable enough to be a selector).'
					)
				}
				consecutiveFailures = 0
				return candidates
			} catch (error) {
				// A cancelled task is not a generator failure: the task's own abort
				// handling takes over, and this must not burn the failure budget.
				if ((error as { name?: string })?.name === 'AbortError') return null
				return fail(error instanceof Error ? error.message : String(error))
			}
		},
		reset() {
			stopped = false
			consecutiveFailures = 0
		},
	}
}
