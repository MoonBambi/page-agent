/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 */
import { type AgentConfig, type ExecutionResult, PageAgentCore } from '@page-agent/core'
import type { LLMConfig } from '@page-agent/llms'
import {
	DEFAULT_LOG_SERVER_URL,
	PageController,
	type PageControllerConfig,
} from '@page-agent/page-controller'
import { Panel, type PanelConfig } from '@page-agent/ui'

import { type PreciseXpathGenerator, createPreciseXpathGenerator } from './preciseXpath'

export * from '@page-agent/core'

export type PageAgentConfig = AgentConfig &
	PageControllerConfig &
	Omit<PanelConfig, 'language'> & {
		/**
		 * Base URL of the local flows/log server (see `scripts/flows-server.mjs`),
		 * used both to resolve `/run <flow>` panel commands into `.md` task files
		 * and as the xpath log export target. When unset, falls back to
		 * `xpathLogServerUrl`, then to `DEFAULT_LOG_SERVER_URL`.
		 * @default 'http://127.0.0.1:8787'
		 */
		flowsBaseUrl?: string
		/**
		 * Overrides for the auxiliary LLM calls made by built-in features (currently
		 * precise-xpath generation). Merged over the agent's own LLM config, so
		 * auxiliary work can run on a cheaper/faster model, a different endpoint or
		 * a smaller retry budget while inheriting everything else.
		 *
		 * @example
		 * // main loop on a strong model, xpath generation on a cheap one
		 * new PageAgent({ model: 'deepseek-v4-pro', auxLlm: { model: 'deepseek-v4-flash', maxRetries: 1 } })
		 * @note Keys explicitly set to `undefined` keep the inherited value.
		 */
		auxLlm?: Partial<LLMConfig>
	}

export class PageAgent extends PageAgentCore {
	panel: Panel

	readonly #flowsBaseUrl: string

	/**
	 * Precise-xpath generator, when this agent created one. Held only to re-arm
	 * its failure budget at the start of each task.
	 */
	readonly #preciseXpath?: PreciseXpathGenerator

	constructor(config: PageAgentConfig) {
		const flowsBaseUrl = (
			config.flowsBaseUrl ??
			config.xpathLogServerUrl ??
			DEFAULT_LOG_SERVER_URL
		).replace(/\/+$/, '')

		// The generator is the agent layer's half of precise-xpath logging: it
		// calls an LLM, so it is built here and injected into the controller, which
		// verifies what it returns and never talks to an LLM itself.
		const preciseXpath = config.enablePreciseXpath
			? createPreciseXpathGenerator({ config, overrides: config.auxLlm })
			: undefined

		const pageController = new PageController({
			...config,
			enableMask: config.enableMask ?? true,
			xpathLogServerUrl: flowsBaseUrl,
			preciseXpathProvider: config.preciseXpathProvider ?? preciseXpath?.provider,
		})

		super({ ...config, pageController })

		this.#preciseXpath = preciseXpath
		this.#flowsBaseUrl = flowsBaseUrl

		this.panel = new Panel(this, {
			language: config.language,
			promptForNextTask: config.promptForNextTask,
		})
	}

	/**
	 * Execute a task. When the task is a `/run <flow>` command, the flow's
	 * `.md` file is fetched from the local flow server first and its content
	 * becomes the task. Any other input runs as-is.
	 *
	 * When the task finishes, the xpath log (elements the LLM selected while
	 * executing this task) is exported as a brand new JSON Lines (`.jsonl`)
	 * file 鈥?via the local log server, or via a browser download when the
	 * server is unreachable. With `enablePreciseXpath`, each entry additionally
	 * carries a precise attribute-based xpath verified against the live DOM to
	 * select exactly the selected element. Entries that could not be exported are
	 * kept for the next successful export instead of being dropped.
	 */
	async execute(task: string): Promise<ExecutionResult> {
		// Auxiliary generation is allowed to give up on a broken endpoint, but only
		// for this task: a later task must not inherit that verdict.
		this.#preciseXpath?.reset()
		try {
			return await this.#executeTask(task)
		} finally {
			// Export the xpaths the LLM selected during this task as a new file.
			try {
				await this.pageController.downloadXPathLog()
			} catch (error) {
				console.error('[PageAgent] Failed to export xpath log:', error)
			}
		}
	}

	/**
	 * Resolve and run a single task (handles `/run <flow>` commands).
	 *
	 * Deterministic `/run` errors (missing flow name, unreadable flow file) are
	 * reported through the normal agent run instead of being thrown or returned
	 * directly: the panel surfaces run outcomes via agent status/history events,
	 * so a direct short-circuit would leave the panel stuck in its hidden input
	 * state and make its close button dispose the whole agent.
	 */
	async #executeTask(task: string): Promise<ExecutionResult> {
		const t = task.trim()
		if (!t.startsWith('/run')) {
			return super.execute(task)
		}

		const flowName = t.slice('/run'.length).trim()
		if (!flowName) {
			return super.execute(
				'Do not operate the page. Immediately report an error with the done tool (success=false) and end the task: the /run command is missing a flow name. Usage: /run <flow-name>'
			)
		}

		let content: string | null = null
		try {
			content = await this.#loadFlowFile(flowName)
		} catch (error) {
			console.error('[PageAgent] Failed to load flow file:', error)
		}

		if (!content) {
			return super.execute(
				`Do not operate the page. Immediately report an error with the done tool (success=false) and end the task: failed to read the flow file "${flowName}.md" from the local flow server (${this.#flowsBaseUrl}). Make sure the server is running (npm run flows) and that the file exists in the flows directory.`
			)
		}

		console.log(`[PageAgent] Running flow from file: ${flowName}.md`)
		return super.execute(content)
	}

	/** Fetch a flow file's markdown content from the local flow server. */
	async #loadFlowFile(name: string): Promise<string> {
		const url = `${this.#flowsBaseUrl}/flows/${encodeURIComponent(name)}.md`
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} for ${url}`)
		}
		return (await response.text()).trim()
	}
}
