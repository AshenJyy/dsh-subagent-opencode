/**
 * OpenCode ACP wire adapter. The Harness transport owns JSON-RPC framing and
 * request correlation. This module owns the private session, full-access replies,
 * assistant-message selection, native cancellation, and bounded session release.
 */
import type { Readable, Writable } from 'node:stream'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

/** Included in diagnostics so a stale installed bundle is immediately visible. */
export const PLUGIN_VERSION = '0.1.2'

export interface OpenCodeWireFailureFacts {
  readonly stage: 'initialize' | 'session-new' | 'session-config' | 'prompt' | 'turn'
  readonly category: 'limit' | 'access-policy' | 'service' | 'transport' | 'product-error' | 'invalid-result' | 'unknown'
  readonly httpStatus?: number
  readonly rpcCode?: number
  readonly errorName?: string
  readonly service?: string
  readonly reason?: string
  readonly model?: string
  readonly field?: string
  readonly message?: string
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-opencode: invalid ACP ${label}`)
  }
  return value as JsonObject
}

function optionalObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`subagent-opencode: invalid ACP ${label}`)
  return value
}

function thrown(error: unknown): Error {
  return error instanceof Error ? error : new Error('subagent-opencode: ACP operation failed')
}

/** Observe both promises and remove the abort listener on every settlement path. */
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('subagent-opencode: ACP operation cancelled'))
    const finish = (): void => signal.removeEventListener('abort', abort)
    pending.then(value => { finish(); resolve(value) }, error => { finish(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** Restrict machine fields; human-readable error summaries are separately redacted. */
function machineLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
    && !/^(sk[-_]|Bearer|token|password|secret)/i.test(value) ? value : undefined
}

function modelLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9][a-zA-Z0-9._/+@:#-]{0,159}$/.test(value)
    ? value : undefined
}

/** Retain a bounded native error summary, never the raw response body or error data. */
function errorSummary(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let text = value
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join('[REDACTED]')
  }
  text = text
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>;,]+/gi, '[REDACTED AUTH]')
    .replace(/\b(?:sk|pk|key|token)[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED TOKEN]')
    .replace(/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try {
        const url = new URL(value)
        // User info, query parameters and fragments can all carry credentials.
        return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?[REDACTED]' : ''}`
      } catch { return '[REDACTED URL]' }
    })
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 600 ? `${text.slice(0, 600)}...` : text
}

/** ACP wraps native provider failures as -32603 with data.errorName/data.service. */
export function failureFacts(error: unknown, stage: OpenCodeWireFailureFacts['stage'], secrets: readonly string[] = []): OpenCodeWireFailureFacts {
  if (error instanceof JsonRpcResponseError) {
    const data = optionalObject(error.data)
    const status = data?.status ?? data?.statusCode ?? optionalObject(data?.error)?.status
    const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status : undefined
    const rpcCode = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : undefined
    const errorName = machineLabel(data?.errorName ?? optionalObject(data?.error)?.type)
    const service = machineLabel(data?.service)
    const field = machineLabel(data?.field ?? data?.configId)
    const message = errorSummary(error.message, secrets)
    const clue = `${errorName ?? ''} ${error.message}`.toLowerCase()
    let category: OpenCodeWireFailureFacts['category'] = 'product-error'
    let reason = 'native-request-failed'
    if (rpcCode === -32000 || httpStatus === 401 || /provider\.auth|authentication required|invalid api.?key|unauthorized|not authenticated/.test(clue)) {
      category = 'access-policy'; reason = 'provider-authentication-required'
    } else if (/insufficient.{0,30}(balance|credit|fund)|billing|payment required|balance.{0,20}(low|insufficient)|余额不足|欠费/.test(clue) || httpStatus === 402) {
      category = 'limit'; reason = 'provider-billing-or-balance'
    } else if (/quota|usage.?limit|额度|配额/.test(clue)) {
      category = 'limit'; reason = 'provider-quota-exhausted'
    } else if (httpStatus === 429 || /rate.?limit|too many requests/.test(clue)) {
      category = 'limit'; reason = 'provider-rate-limit'
    } else if (/context.{0,20}(length|window|limit)|too many tokens/.test(clue)) {
      category = 'limit'; reason = 'context-limit'
    } else if (/model.{0,40}(not found|not available|not supported|does not exist)|no models are available/.test(clue)) {
      category = 'product-error'; reason = 'model-unavailable'
    } else if (httpStatus === 403 || /forbidden|access.denied|permission.denied|policy|content.filter/.test(clue)) {
      category = 'access-policy'; reason = 'native-access-denied'
    } else if (/serverunavailable|server is unavailable|econn|enotfound|connection|network|timed?\s*out|timeout|fetch failed/.test(clue)) {
      category = 'transport'; reason = 'native-connection-failed'
    } else if ((httpStatus !== undefined && httpStatus >= 500) || /overload|service.unavailable/.test(clue)) {
      category = 'service'; reason = 'provider-service-failed'
    } else if (rpcCode === -32602) {
      reason = 'invalid-acp-parameters'
    } else if (rpcCode === -32601) {
      reason = 'unsupported-acp-method'
    } else if (rpcCode === -32603) {
      category = 'service'; reason = 'native-service-failed'
    }
    return {
      stage, category, reason,
      ...(rpcCode === undefined ? {} : { rpcCode }),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(errorName === undefined ? {} : { errorName }),
      ...(service === undefined ? {} : { service }),
      ...(field === undefined ? {} : { field }),
      ...(message === undefined ? {} : { message }),
    }
  }
  return {
    stage, category: 'unknown',
    ...(error instanceof Error ? { message: errorSummary(error.message, secrets) } : {}),
  }
}

export class OpenCodeAcpWire {
  private readonly input: Readable
  private readonly options: { readonly model?: string; readonly agent: string; readonly secrets?: readonly string[] }
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private sessionId: string | undefined
  private deleteSupported = false
  private closeSupported = false
  private closed = false
  private inputEnded = false
  private terminalObserved = false
  private prompting = false
  private cancelling = false
  private released = false
  private diagnostic: string | undefined
  private selectedModel: string | undefined
  private failure: OpenCodeWireFailureFacts = { stage: 'prompt', category: 'unknown' }
  private readonly messages = new Map<string, string[]>()
  private anonymousMessage = 0
  private anonymousBoundary = false

  constructor(
    input: Readable,
    output: Writable,
    options: { readonly model?: string; readonly agent: string; readonly secrets?: readonly string[] },
  ) {
    this.input = input
    this.options = options
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleRequest(method, params))
    this.transport.onNotification((method, params) => {
      try { this.handleNotification(method, params) } catch (error: unknown) { this.fail(thrown(error)) }
    })
    input.on('error', this.onInputError)
    input.on('end', this.onInputEnd)
    output.on('error', this.onOutputError)
  }

  start(): void { this.transport.start() }

  async initialize(signal: AbortSignal): Promise<void> {
    // This is protocol negotiation, not a CLI version probe or product-version gate.
    const response = object(await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'dsh-subagent-opencode', title: 'DeepSeek Harness OpenCode subagent', version: PLUGIN_VERSION },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, signal, 'initialize'), 'initialize response')
    const sessions = optionalObject(optionalObject(response.agentCapabilities)?.sessionCapabilities)
    this.deleteSupported = sessions?.delete != null
    this.closeSupported = sessions?.close != null
    // ACP has no Codex-style "initialized" notification. Native credentials remain authoritative.
  }

  async startSession(cwd: string, signal: AbortSignal): Promise<void> {
    const response = object(await this.request('session/new', {
      cwd,
      mcpServers: [],
    }, signal, 'session-new'), 'session/new response')
    this.sessionId = string(response.sessionId, 'session id')
    this.observeConfiguration(response)
    try {
      if (this.options.model !== undefined) {
        const configured = await this.request('session/set_config_option', {
          sessionId: this.sessionId, configId: 'model', value: this.options.model,
        }, signal, 'session-config')
        this.observeConfiguration(optionalObject(configured))
      }
      const configured = await this.request('session/set_mode', {
        sessionId: this.sessionId, modeId: this.options.agent,
      }, signal, 'session-config')
      this.observeConfiguration(optionalObject(configured))
    } catch (error: unknown) {
      this.failure = failureFacts(error, 'session-config', this.options.secrets)
      throw error
    }
  }

  async runTurn(texts: readonly string[], signal: AbortSignal): Promise<SubagentResult> {
    if (!this.sessionId) throw new Error('subagent-opencode: ACP session is not ready')
    this.prompting = true
    try {
      const response = object(await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: texts.map(text => ({ type: 'text', text })),
      }, signal, 'prompt'), 'session/prompt response')
      this.terminalObserved = true
      let stopReason: SubagentStopReason
      switch (response.stopReason) {
        case 'end_turn': stopReason = 'completed'; break
        case 'cancelled': stopReason = 'aborted'; break
        case 'max_tokens': case 'max_turn_requests': stopReason = 'max-tokens'; break
        case 'refusal': stopReason = 'refusal'; break
        default:
          this.failure = { stage: 'turn', category: 'invalid-result' }
          throw new Error('subagent-opencode: invalid ACP terminal stop reason')
      }
      const output = this.collectOutput()
      if (stopReason === 'completed' && output.length === 0) {
        this.failure = { stage: 'turn', category: 'invalid-result' }
        throw new Error('subagent-opencode: completed without an answer')
      }
      if (stopReason !== 'completed') {
        this.failure = {
          stage: 'turn',
          category: stopReason === 'max-tokens' ? 'limit' : stopReason === 'refusal' ? 'access-policy' : 'unknown',
        }
      }
      return { output, stopReason }
    } catch (error: unknown) {
      if (this.failure.category === 'unknown') this.failure = failureFacts(error, 'prompt', this.options.secrets)
      throw error
    } finally {
      this.prompting = false
    }
  }

  interrupt(): void {
    this.cancelling = true
    if (!this.sessionId || this.closed || this.inputEnded || this.terminalObserved) return
    try { this.transport.notify('session/cancel', { sessionId: this.sessionId }) } catch { /* Teardown remains authoritative. */ }
  }

  /** Only the session returned by our own session/new can be closed or deleted. */
  async releaseSession(remove: boolean, graceMs: number): Promise<void> {
    if (this.released) return
    this.released = true
    this.interrupt()
    if (!this.sessionId || this.closed || this.inputEnded) return
    const method = remove && this.deleteSupported ? 'session/delete' : this.closeSupported ? 'session/close' : undefined
    if (!method) return
    // A separate cleanup signal must survive cancellation of the original task.
    await this.transport.request(method, { sessionId: this.sessionId }, AbortSignal.timeout(graceMs))
  }

  collectOutput(): ContentBlock[] {
    const answers = [...this.messages.values()]
    for (let i = answers.length - 1; i >= 0; i--) {
      const text = answers[i]!.join('')
      if (text.trim()) return [{ type: 'text', text }]
    }
    return []
  }

  collectDiagnostic(): string | undefined { return this.diagnostic }
  collectMetadata(): string {
    return `Product subagent metadata (product: OpenCode; plugin: ${PLUGIN_VERSION}; selected model: ${this.selectedModel ?? 'not-advertised'}; evidence: ACP configuration, not verified backend identity)`
  }
  collectFailure(): OpenCodeWireFailureFacts {
    return this.selectedModel === undefined ? this.failure : { ...this.failure, model: this.selectedModel }
  }
  endedBeforeTerminal(): boolean { return this.inputEnded && !this.terminalObserved }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
    // Keep stream error listeners until stream disposal to absorb late EPIPE/read errors.
  }

  private guarded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return raceAbort(Promise.race([promise, this.fatal.promise]), signal)
  }

  private async request(method: string, params: object, signal: AbortSignal, stage: OpenCodeWireFailureFacts['stage']): Promise<unknown> {
    try {
      return await this.guarded(this.transport.request(method, params, signal), signal)
    } catch (error: unknown) {
      if (error instanceof JsonRpcResponseError || this.failure.category === 'unknown') {
        this.failure = failureFacts(error, stage, this.options.secrets)
      }
      throw error
    }
  }

  /** Read the server's selected route; do not infer a model from assistant self-identification. */
  private observeConfiguration(response: JsonObject | undefined): void {
    if (!response) return
    if (Array.isArray(response.configOptions)) {
      for (const raw of response.configOptions) {
        const option = optionalObject(raw)
        if (option?.id !== 'model' && option?.category !== 'model') continue
        this.selectedModel = modelLabel(option.currentValue)
      }
    }
    const legacy = optionalObject(response.models)
    if (legacy?.currentModelId !== undefined) this.selectedModel = modelLabel(legacy.currentModelId)
  }

  private fail(error: Error): void { this.fatal.reject(error) }
  private readonly onInputError = (error: Error): void => {
    this.failure = { stage: 'turn', category: 'transport' }
    this.fail(error)
  }
  private readonly onOutputError = (error: Error): void => {
    this.failure = { stage: 'turn', category: 'transport' }
    this.fail(error)
  }
  private readonly onInputEnd = (): void => {
    this.inputEnded = true
    // Preserve a specific native failure when EOF races its response or later cleanup.
    if (this.failure.category === 'unknown') this.failure = { stage: 'turn', category: 'transport' }
    this.fail(new Error('subagent-opencode: ACP stream closed'))
  }

  private async handleRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      if (params.sessionId !== this.sessionId || !this.sessionId) {
        throw new Error('subagent-opencode: request does not belong to this session')
      }
      if (method === 'session/request_permission') {
        if (this.cancelling || this.closed) return { outcome: { outcome: 'cancelled' } }
        if (!Array.isArray(params.options)) throw new Error('subagent-opencode: invalid permission options')
        const options = params.options.map(option => object(option, 'permission option'))
        // Approve every request. Prefer allow_once to avoid modifying saved project rules.
        const selected = options.find(option => option.kind === 'allow_once')
          ?? options.find(option => option.kind === 'allow_always')
        if (!selected) {
          this.failure = { stage: 'turn', category: 'access-policy' }
          this.diagnostic = 'OpenCode permission request offered no allow option.'
          throw new Error('subagent-opencode: no affirmative ACP permission option')
        }
        return { outcome: { outcome: 'selected', optionId: string(selected.optionId, 'permission option id') } }
      }
      if (method === 'elicitation/create') {
        // No interactive user-answer capability is advertised; never invent an answer.
        return { action: 'cancel' }
      }
      throw new Error('subagent-opencode: unsupported ACP client request')
    } catch (error: unknown) {
      this.fail(thrown(error))
      throw error
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method !== 'session/update' || params.sessionId !== this.sessionId) return
    const update = object(params.update, 'session update')
    if (optionalObject(update._meta)?.['opencode/child-session'] || optionalObject(params._meta)?.['opencode/child-session']) return
    if (update.sessionUpdate === 'config_option_update') {
      this.observeConfiguration(update)
      return
    }
    if (!this.prompting || this.terminalObserved) return
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'agent_thought_chunk') {
      this.anonymousBoundary = true
      return
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return
    const content = object(update.content, 'assistant message content')
    if (content.type !== 'text') return
    if (typeof content.text !== 'string') throw new Error('subagent-opencode: invalid assistant text')
    if (this.anonymousBoundary) {
      this.anonymousMessage++
      this.anonymousBoundary = false
    }
    const id = typeof update.messageId === 'string' && update.messageId
      ? `message:${update.messageId}` : `anonymous:${this.anonymousMessage}`
    const chunks = this.messages.get(id)
    if (chunks) chunks.push(content.text)
    else this.messages.set(id, [content.text])
  }
}
