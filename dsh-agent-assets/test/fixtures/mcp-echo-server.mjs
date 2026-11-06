#!/usr/bin/env node
/**
 * Minimal MCP stdio server used by the Agent Assets verification suite.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the MCP stdio transport), answers `initialize`,
 * `tools/list` and `tools/call`, and exposes exactly two tools:
 *
 *   echo(text)   -> the text back
 *   add(a, b)    -> the sum
 *
 * Dependency-free on purpose: no network, no filesystem writes, so a verification run cannot leak.
 */

import { createInterface } from 'node:readline'

const SERVER_INFO = { name: 'agent-assets-echo', version: '1.0.0' }
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the supplied text back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  if (message === null || typeof message !== 'object') return
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null

  switch (method) {
    case 'initialize': {
      // Echo the client's protocol version so any SDK generation negotiates successfully.
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18'
      if (isRequest) {
        result(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      }
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      if (isRequest) result(id, {})
      return
    case 'tools/list':
      if (isRequest) result(id, { tools: TOOLS })
      return
    case 'tools/call': {
      if (!isRequest) return
      const name = params?.name
      const args = params?.arguments ?? {}
      if (name === 'echo') {
        result(id, { content: [{ type: 'text', text: String(args.text ?? '') }] })
        return
      }
      if (name === 'add') {
        const sum = Number(args.a) + Number(args.b)
        result(id, { content: [{ type: 'text', text: String(sum) }] })
        return
      }
      error(id, -32602, `unknown tool: ${String(name)}`)
      return
    }
    case 'resources/list':
      if (isRequest) result(id, { resources: [] })
      return
    case 'resources/templates/list':
      if (isRequest) result(id, { resourceTemplates: [] })
      return
    case 'prompts/list':
      if (isRequest) result(id, { prompts: [] })
      return
    default:
      if (isRequest) error(id, -32601, `method not found: ${String(method)}`)
  }
})
