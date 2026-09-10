/**
 * OpenAI Client implementation
 */
import * as z from 'zod/v4'

import { InvokeError, type InvokeErrorType, InvokeErrorTypes } from './errors'
import type {
	InvokeOptions,
	InvokeResult,
	LLMClient,
	Message,
	ResolvedLLMConfig,
	Tool,
} from './types'
import { modelPatch, zodToOpenAITool } from './utils'

/**
 * Pick the most useful message out of a non-OK response body.
 *
 * Providers are not consistent about where they put it, and a body that is
 * parsed successfully but has no `error.message` must not degrade to the bare
 * HTTP status text — that hides the actual reason from the user:
 * - OpenAI and most gateways: `{ error: { message } }`
 * - flat gateways/proxies (DashScope, the page-agent demo relay):
 *   `{ error: 'Invalid request', message: '...' }` or `{ code, message }`
 *
 * @returns The first usable message found, else the HTTP status text.
 */
export function extractErrorMessage(errorData: unknown, response: Response): string {
	const data = errorData as { error?: unknown; message?: unknown } | undefined
	const nested =
		typeof data?.error === 'object' && data.error !== null
			? (data.error as { message?: unknown }).message
			: undefined

	for (const candidate of [nested, data?.message, data?.error]) {
		if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
	}

	return response.statusText || `HTTP ${response.status}`
}

/**
 * Client for OpenAI compatible APIs
 */
export class OpenAIClient implements LLMClient {
	config: ResolvedLLMConfig
	private fetch: typeof globalThis.fetch

	constructor(config: ResolvedLLMConfig) {
		this.config = config
		this.fetch = config.customFetch
	}

	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()

		// 1. Convert tools to OpenAI format
		const openaiTools = Object.entries(tools).map(([name, t]) => zodToOpenAITool(name, t))

		// Build request body

		let toolChoice: unknown = 'required'
		if (options?.toolChoiceName && !this.config.disableNamedToolChoice) {
			toolChoice = { type: 'function', function: { name: options.toolChoiceName } }
		}

		const requestBody: Record<string, unknown> = {
			model: this.config.model,
			messages,
			tools: openaiTools,
			parallel_tool_calls: false,
			tool_choice: toolChoice,
		}
		// Only sent if the caller explicitly set it. Most new models throw if this is set.
		if (this.config.temperature !== undefined) {
			requestBody.temperature = this.config.temperature
		}

		modelPatch(requestBody, this.config.baseURL)

		let transformedBody: Record<string, unknown> | undefined
		try {
			transformedBody = this.config.transformRequestBody(requestBody)
		} catch (error) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				`transformRequestBody failed: ${(error as Error).message}`,
				error
			)
		}
		const finalRequestBody = transformedBody ?? requestBody

		// 2. Call API
		let response: Response
		try {
			response = await this.fetch(`${this.config.baseURL}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
				},
				body: JSON.stringify(finalRequestBody),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			console.error(error)
			throw new InvokeError(InvokeErrorTypes.NETWORK_ERROR, 'Network request failed', error)
		}

		// 3. Handle HTTP errors
		if (!response.ok) {
			let errorData: any
			try {
				errorData = await response.json()
			} catch (error) {
				if ((error as any)?.name === 'AbortError') throw error
			}
			const errorMessage = extractErrorMessage(errorData, response)

			// Keep the status code on the error: callers that retry or fall back
			// need to tell "the endpoint rejected this" from "the network broke".
			const httpError = (type: InvokeErrorType, message: string): InvokeError => {
				const error = new InvokeError(type, message, errorData)
				error.statusCode = response.status
				return error
			}

			if (response.status === 401 || response.status === 403) {
				throw httpError(
					InvokeErrorTypes.AUTH_ERROR,
					`Authentication failed (HTTP ${response.status}): ${errorMessage}`
				)
			}
			if (response.status === 429) {
				throw httpError(InvokeErrorTypes.RATE_LIMIT, `Rate limit exceeded: ${errorMessage}`)
			}
			if (response.status >= 500) {
				throw httpError(InvokeErrorTypes.SERVER_ERROR, `Server error: ${errorMessage}`)
			}
			throw httpError(InvokeErrorTypes.UNKNOWN, `HTTP ${response.status}: ${errorMessage}`)
		}

		// 4. Parse and validate response
		let data: any
		try {
			data = await response.json()
		} catch (error) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'Response body is not valid JSON',
				error
			)
		}

		const choice = data.choices?.[0]
		if (!choice) {
			throw new InvokeError(InvokeErrorTypes.INVALID_SCHEMA, 'No choices in response', data)
		}

		// Check finish_reason
		switch (choice.finish_reason) {
			case 'tool_calls':
			case 'function_call': // gemini
			case 'stop': // some models use this even with tool calls
				break
			case 'length':
				throw new InvokeError(
					InvokeErrorTypes.CONTEXT_LENGTH,
					'Response truncated: max tokens reached',
					undefined,
					data
				)
			case 'content_filter':
				throw new InvokeError(
					InvokeErrorTypes.CONTENT_FILTER,
					'Content filtered by safety system',
					undefined,
					data
				)
			default:
				throw new InvokeError(
					InvokeErrorTypes.INVALID_SCHEMA,
					`Unexpected finish_reason: ${choice.finish_reason}`,
					undefined,
					data
				)
		}

		// Apply normalizeResponse if provided (for fixing format issues automatically)
		const normalizedData = options?.normalizeResponse ? options.normalizeResponse(data) : data
		const normalizedChoice = (normalizedData as any).choices?.[0]

		// Get tool name from response
		const toolCallName = normalizedChoice?.message?.tool_calls?.[0]?.function?.name
		if (!toolCallName) {
			throw new InvokeError(
				InvokeErrorTypes.NO_TOOL_CALL,
				'No tool call found in response',
				undefined,
				data
			)
		}

		const tool = tools[toolCallName]
		if (!tool) {
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`Tool "${toolCallName}" not found in tools`,
				undefined,
				data
			)
		}

		// Extract and parse tool arguments
		const argString = normalizedChoice.message?.tool_calls?.[0]?.function?.arguments
		if (!argString) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'No tool call arguments found',
				undefined,
				data
			)
		}

		let parsedArgs: unknown
		try {
			parsedArgs = JSON.parse(argString)
		} catch (error) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'Failed to parse tool arguments as JSON',
				error,
				data
			)
		}

		// Validate with schema
		const validation = tool.inputSchema.safeParse(parsedArgs)
		if (!validation.success) {
			console.error(z.prettifyError(validation.error))
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'Tool arguments validation failed',
				validation.error,
				data
			)
		}
		const toolInput = validation.data

		// 5. Execute tool
		let toolResult: unknown
		try {
			toolResult = await tool.execute(toolInput)
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.TOOL_EXECUTION_ERROR,
				`Tool execution failed: ${(error as Error)?.message}`,
				error,
				data
			)
		}

		// Return result
		return {
			toolCall: {
				name: toolCallName,
				args: toolInput,
			},
			toolResult,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
				reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
			},
			rawResponse: data,
			rawRequest: finalRequestBody,
		}
	}
}
