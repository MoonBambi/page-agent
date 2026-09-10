#!/usr/bin/env node
/**
 * Read-only local server that exposes flow markdown files (repo `flows/`) over HTTP.
 *
 * The Page Agent demo runs inside a webpage (your business system), and browsers
 * cannot read local filesystem paths directly. This server is the bridge: the agent
 * fetches the requested `.md` from here over HTTP and executes it as a task.
 *
 * Usage:
 *   node scripts/flows-server.mjs            # serve repo-root flows/ on 127.0.0.1:8787
 *   FLOWS_DIR=D:\my\flows node scripts/flows-server.mjs   # custom directory
 *   FLOWS_PORT=9000 node scripts/flows-server.mjs          # custom port
 *   FLOWS_ALLOW_ORIGIN=http://localhost:5174 node scripts/flows-server.mjs  # restrict CORS
 *
 * Endpoints:
 *   GET  /flows                  -> JSON list of flow names (without .md)
 *   GET  /flows/<name>.md        -> raw markdown content (text/plain; charset=utf-8)
 *   POST /logs                   -> save xpath/agent logs to <repo>/logs/<name>.txt|.jsonl
 *
 * Note: by default the server answers with `Access-Control-Allow-Origin: *` and
 * binds to 127.0.0.1. Any website open in the user's browser can then read flow
 * files and write log files while the server runs. Set FLOWS_ALLOW_ORIGIN to a
 * concrete origin to restrict this (a dev server origin like http://localhost:5174).
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const flowsDir = resolve(process.env.FLOWS_DIR ?? join(rootDir, 'flows'))
const logsDir = resolve(process.env.FLOWS_LOG_DIR ?? join(rootDir, 'logs'))
const host = process.env.FLOWS_HOST ?? '127.0.0.1'
const port = Number(process.env.FLOWS_PORT ?? 8787)

// Any page (including your business system, possibly on another origin) may read flows.
// '*' is the convenient default for local development, but it also lets any website
// the user visits read flow files and write log files. Restrict via FLOWS_ALLOW_ORIGIN.
const allowOrigin = process.env.FLOWS_ALLOW_ORIGIN ?? '*'
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': allowOrigin,
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	...(allowOrigin === '*' ? {} : { Vary: 'Origin' }),
}

/** List of flow names in the flows dir, without the `.md` extension. */
async function listFlows() {
	const files = await readdir(flowsDir)
	return files
		.filter((f) => f.endsWith('.md'))
		.map((f) => f.slice(0, -3))
		.sort()
}

/**
 * Resolve a requested file name against the flows dir.
 * Rejects path traversal and anything outside flowsDir; only `.md` files are served.
 * @returns {string | null} absolute file path, or null when the request is unsafe
 */
function resolveFlowPath(rawName) {
	let name
	try {
		name = decodeURIComponent(rawName)
	} catch {
		return null // malformed percent-encoding
	}
	if (!name.endsWith('.md') || name.startsWith('.') || basename(name) !== name) {
		return null
	}
	const filePath = join(flowsDir, name)
	return filePath.startsWith(flowsDir) ? filePath : null
}

function sendJson(res, status, data) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS })
	res.end(JSON.stringify(data))
}

function sendText(res, status, text) {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS })
	res.end(text)
}

/** Collect the request body as a UTF-8 string, capped at `limit` bytes. */
function readBody(req, limit = 1_000_000) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				reject(new Error('request body exceeds 1 MB limit'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
		req.on('error', reject)
	})
}

const server = createServer(async (req, res) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(204, CORS_HEADERS)
		res.end()
		return
	}

	const url = new URL(req.url ?? '/', `http://${host}`)
	const pathname = url.pathname.replace(/\/+$/, '')

	if (req.method === 'POST' && pathname === '/logs') {
		let body
		try {
			body = await readBody(req)
		} catch (error) {
			sendJson(res, 413, { error: error.message })
			return
		}
		let name = ''
		let content = body
		try {
			const parsed = JSON.parse(body)
			if (typeof parsed.name === 'string') name = parsed.name
			if (typeof parsed.content === 'string') content = parsed.content
		} catch {
			// Raw text body is also accepted (content = body).
		}
		const safeName =
			name && /^[\w\u4e00-\u9fff-]+\.(txt|jsonl)$/.test(name)
				? name
				: `page-agent-xpath-${Date.now()}.jsonl`
		try {
			await mkdir(logsDir, { recursive: true })
			const filePath = join(logsDir, safeName)
			await writeFile(filePath, content, 'utf-8')
			sendJson(res, 201, { ok: true, file: filePath })
		} catch (error) {
			sendJson(res, 500, { error: `Cannot write log file: ${error.message}` })
		}
		return
	}

	if (req.method !== 'GET') {
		sendJson(res, 405, { error: 'Only GET or POST /logs is allowed' })
		return
	}

	if (pathname === '/flows') {
		try {
			const flows = await listFlows()
			sendJson(res, 200, { flows })
		} catch (error) {
			sendJson(res, 500, { error: `Cannot read flows dir ${flowsDir}: ${error.message}` })
		}
		return
	}

	const match = /^\/flows\/(.+)$/.exec(pathname)
	if (!match) {
		sendJson(res, 404, { error: 'Not found. Use GET /flows or GET /flows/<name>.md' })
		return
	}

	const filePath = resolveFlowPath(match[1])
	if (!filePath) {
		sendJson(res, 400, { error: 'Invalid file name' })
		return
	}

	try {
		const content = await readFile(filePath, 'utf-8')
		sendText(res, 200, content)
	} catch {
		sendJson(res, 404, { error: `Flow file not found: ${basename(filePath)}` })
	}
})

server.on('error', (error) => {
	if (error.code === 'EADDRINUSE') {
		console.error(`✘ Port ${port} is already in use. Stop the other process or set FLOWS_PORT.`)
	} else {
		console.error(`✘ Flows server error: ${error.message}`)
	}
	process.exit(1)
})

server.listen(port, host, () => {
	console.log(`✔ Flows server ready`)
	console.log(`  Flows dir : ${flowsDir}`)
	console.log(`  Logs dir  : ${logsDir}`)
	console.log(`  List      : http://${host}:${port}/flows`)
	console.log(`  File      : http://${host}:${port}/flows/<name>.md`)
	console.log(`  Save logs : POST http://${host}:${port}/logs  {"name":"x.jsonl","content":"..."}`)
	if (allowOrigin === '*') {
		console.warn(
			`  ⚠ CORS is open to any origin (Access-Control-Allow-Origin: *). Any website open in your browser can read flows/ and write logs/. Set FLOWS_ALLOW_ORIGIN (e.g. http://localhost:5174) to restrict.`
		)
	}
})
