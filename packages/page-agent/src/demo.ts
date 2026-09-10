/**
 * IIFE demo entry - auto-initializes with built-in demo API for testing
 */
import { PageAgent, type PageAgentConfig } from './PageAgent'

const currentScript = document.currentScript as HTMLScriptElement | null
const currentScriptURL = currentScript?.src ? new URL(currentScript.src) : null
const autoInit = currentScriptURL?.searchParams.get('autoInit') !== 'false'

// Clean up existing instances to prevent multiple injections from bookmarklet
if (autoInit && window.pageAgent) {
	window.pageAgent.dispose()
}

// Mount to global window object
window.PageAgent = PageAgent

console.log('🚀 page-agent.js loaded!')

const DEMO_MODEL = 'qwen3.5-plus'
const DEMO_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const DEMO_API_KEY = 'NA'

/**
 * Resolve one setting with the intended precedence:
 * explicit URL parameter → value baked in at build time from `.env` → shared demo default.
 *
 * @note The URL-parameter branch used to skip the baked `.env` values entirely,
 * so a demo bundle built from an environment that already set `LLM_*` still
 * talked to the shared demo proxy — which rejects anything that is not the
 * official page-agent system prompt (e.g. the precise-xpath call).
 */
function resolveSetting(
	param: string | null,
	bakedIn: string | undefined,
	fallback: string
): string {
	return param || bakedIn || fallback
}

// in case document.x is not ready yet
if (autoInit) {
	setTimeout(() => {
		let config: PageAgentConfig
		let showPanel = true

		if (currentScriptURL) {
			const url = currentScriptURL
			const model = resolveSetting(
				url.searchParams.get('model'),
				import.meta.env.LLM_MODEL_NAME,
				DEMO_MODEL
			)
			const baseURL = resolveSetting(
				url.searchParams.get('baseURL'),
				import.meta.env.LLM_BASE_URL,
				DEMO_BASE_URL
			)
			const apiKey = resolveSetting(
				url.searchParams.get('apiKey'),
				import.meta.env.LLM_API_KEY,
				DEMO_API_KEY
			)
			const language = (url.searchParams.get('lang') as 'zh-CN' | 'en-US') || 'zh-CN'
			showPanel = ((url.searchParams.get('showPanel') as 'true' | 'false') || 'true') === 'true'
			// Opt-in: log a precise attribute-based xpath for each selected element
			// (verified unique against the live DOM by an extra LLM call per action).
			const enablePreciseXpath = url.searchParams.get('preciseXpath') === 'true'
			config = { model, baseURL, apiKey, language, enablePreciseXpath }

			if (enablePreciseXpath && baseURL === DEMO_BASE_URL) {
				console.warn(
					'[PageAgent] preciseXpath=true needs your own LLM endpoint: the precise-xpath call ' +
						'sends its own system prompt, which the shared demo proxy rejects with HTTP 403. ' +
						'Set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL_NAME in .env and rebuild the demo ' +
						'bundle (or pass ?baseURL=<endpoint>&apiKey=<key>), or drop ?preciseXpath=true.'
				)
			}
		} else {
			console.log('🚀 page-agent.js no current script detected, using default demo config')
			config = {
				model: resolveSetting(null, import.meta.env.LLM_MODEL_NAME, DEMO_MODEL),
				baseURL: resolveSetting(null, import.meta.env.LLM_BASE_URL, DEMO_BASE_URL),
				apiKey: resolveSetting(null, import.meta.env.LLM_API_KEY, DEMO_API_KEY),
			}
		}

		// Create agent
		window.pageAgent = new PageAgent(config)
		if (showPanel) {
			window.pageAgent.panel.show()
		}

		console.log('🚀 page-agent.js initialized with config:', window.pageAgent.config)
	})
}
