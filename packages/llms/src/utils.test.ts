import { describe, expect, it } from 'vitest'

import { mergeLLMConfig, modelPatch, normalizeModelName } from './utils'

describe('normalizeModelName', () => {
	it.each([
		['gpt-5.2', 'gpt-52'],
		['gpt_5_2', 'gpt52'],
		['GPT-52-2026-01-01', 'gpt-52-2026-01-01'],
		['openai/gpt-5.2-chat', 'gpt-52-chat'],
		['claude_sonnet4_5', 'claudesonnet45'],
	])('%s -> %s', (input, expected) => {
		expect(normalizeModelName(input)).toBe(expected)
	})
})

describe('modelPatch', () => {
	it('disables DeepSeek thinking and keeps the named tool_choice', () => {
		// Thinking off is what allows a named tool_choice; dropping tool_choice
		// as well would silently give up the forced-tool contract.
		const body: Record<string, any> = {
			model: 'deepseek-v4-flash',
			tool_choice: { type: 'function', function: { name: 'AgentOutput' } },
		}

		modelPatch(body)

		expect(body.thinking).toEqual({ type: 'disabled' })
		expect(body.tool_choice).toEqual({
			type: 'function',
			function: { name: 'AgentOutput' },
		})
	})
})

describe('mergeLLMConfig', () => {
	const base = {
		baseURL: 'https://main.example',
		model: 'big-model',
		apiKey: 'main-key',
		maxRetries: 2,
	}

	it('lets overrides win and keeps the rest inherited', () => {
		expect(mergeLLMConfig(base, { model: 'small-model' })).toEqual({
			baseURL: 'https://main.example',
			model: 'small-model',
			apiKey: 'main-key',
			maxRetries: 2,
		})
	})

	it('ignores keys explicitly set to undefined', () => {
		// A partially-filled overrides object must not erase inherited settings.
		expect(mergeLLMConfig(base, { model: 'small-model', apiKey: undefined })).toEqual({
			baseURL: 'https://main.example',
			model: 'small-model',
			apiKey: 'main-key',
			maxRetries: 2,
		})
	})

	it('returns the base config when there are no overrides', () => {
		expect(mergeLLMConfig(base)).toBe(base)
	})

	it('never mutates the base config', () => {
		mergeLLMConfig(base, { model: 'small-model', apiKey: 'other-key' })
		expect(base).toEqual({
			baseURL: 'https://main.example',
			model: 'big-model',
			apiKey: 'main-key',
			maxRetries: 2,
		})
	})
})
