/**
 * One-shot OpenCode child lifecycle: spawn the real ACP through the
 * subprocess seam, publish only after initialization and fresh session
 * creation, flatten post-publication failures, and dispose to whole-range
 * quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-opencode/run
 */

import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  failureFacts,
  OpenCodeAcpWire,
  PLUGIN_VERSION,
  type OpenCodeWireFailureFacts,
} from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** This build intentionally exposes the user-requested full-access mode only. */
export type OpenCodePermissionMode = 'full-access'

type OpenCodeFailureStage =
  | 'initialize'
  | 'session-new'
  | OpenCodeWireFailureFacts['stage']
  | 'process'
  | 'teardown'

type OpenCodeFailureCategory = OpenCodeWireFailureFacts['category'] | 'process'

interface OpenCodeFailureFacts extends Omit<OpenCodeWireFailureFacts, 'stage' | 'category'> {
  readonly stage: OpenCodeFailureStage
  readonly category: OpenCodeFailureCategory
  readonly httpStatus?: number | undefined
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: OpenCodeFailureFacts): string {
  const fields = [
    'product: OpenCode',
    `plugin: ${PLUGIN_VERSION}`,
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.httpStatus !== undefined) {
    fields.push(`HTTP status: ${facts.httpStatus}`)
  }
  if (facts.rpcCode !== undefined) fields.push(`ACP code: ${facts.rpcCode}`)
  if (facts.errorName !== undefined) fields.push(`native error: ${facts.errorName}`)
  if (facts.service !== undefined) fields.push(`service: ${facts.service}`)
  if (facts.reason !== undefined) fields.push(`reason: ${facts.reason}`)
  if (facts.model !== undefined) fields.push(`selected model: ${facts.model}`)
  if (facts.field !== undefined) fields.push(`field: ${facts.field}`)
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  const summary = `Product subagent failure (${fields.join('; ')})`
  return facts.message === undefined ? summary : `${summary}\nNative error summary (redacted): ${facts.message}`
}

class OpenCodeRunFailure extends Error {
  readonly facts: OpenCodeFailureFacts
  constructor(
    facts: OpenCodeFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-opencode: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.facts = facts
    this.name = 'OpenCodeRunFailure'
  }
}

/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export function opencodeStartupFailure(cause: unknown): Error {
  return new OpenCodeRunFailure({
    stage: 'initialize',
    category: 'unknown',
  }, cause)
}

/**
 * Resolve the existing CLI without installing it, launching a shell, or probing its version.
 * Windows npm shims are resolved to the adjacent native CLI instead of passed to cmd.exe.
 */
export function opencodeAcpArgv(command: string, cwd: string, env: Record<string, string>): string[] {
  if (!command.trim() || command.includes('\0')) throw new Error('subagent-opencode: invalid CLI command')
  let executable = command
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    executable = resolve(cwd, command)
  } else if (process.platform === 'win32') {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
    const searchPath = (pathKey ? env[pathKey] : process.env.PATH) ?? ''
    const candidates = searchPath.split(delimiter).filter(Boolean).flatMap(directory => {
      const base = join(directory.replace(/^"|"$/g, ''), command)
      return extname(base) ? [base] : [base + '.exe', base + '.cmd', base + '.bat', base]
    })
    executable = candidates.find(candidate => existsSync(candidate)) ?? command
  }
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(executable)) {
    const adjacent = join(dirname(executable), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
    if (!existsSync(adjacent)) {
      throw new Error('subagent-opencode: configure command as the existing opencode.exe or Node script')
    }
    executable = adjacent
  }
  return /\.[cm]?js$/i.test(executable)
    ? [process.execPath, executable, 'acp']
    : [executable, 'acp']
}

/** Override this child only; preserve native auth, models, instructions, MCP and disk configuration. */
export function fullAccessEnvironment(env: Record<string, string>, agent: string): Record<string, string> {
  const inherited = env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT
  let content: Record<string, unknown> = {}
  if (inherited?.trim()) {
    let parsed: unknown
    try { parsed = JSON.parse(inherited) } catch {
      throw new Error('subagent-opencode: OPENCODE_CONFIG_CONTENT must be a JSON object')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('subagent-opencode: OPENCODE_CONFIG_CONTENT must be a JSON object')
    }
    content = parsed as Record<string, unknown>
  }
  const allow = { action: '*', resource: '*', effect: 'allow' }
  const agents = content.agents && typeof content.agents === 'object' && !Array.isArray(content.agents)
    ? content.agents as Record<string, unknown> : {}
  const configured = agents[agent]
  const primary = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown> : {}
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...content,
      default_agent: agent,
      permissions: [...(Array.isArray(content.permissions) ? content.permissions : []), allow],
      agents: {
        ...agents,
        [agent]: {
          ...primary,
          permissions: [...(Array.isArray(primary.permissions) ? primary.permissions : []), allow],
        },
      },
    }),
  }
}

/** Fully resolved inputs for one OpenCode ACP run. */
export interface OpenCodeRunSpec {
  /** Selected child working directory, also supplied to `session/new`. */
  readonly cwd: string
  readonly command: string
  readonly agent: string
  readonly deleteSession: boolean
  /** Profile-selected native model; omitted to preserve OpenCode settings. */
  readonly model?: string
  /** Profile-selected native non-interactive permission mode. */
  readonly permissionMode: OpenCodePermissionMode
  /** Explicit deployment environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/** Known environment credentials are removed before native errors reach diagnostics. */
function diagnosticSecrets(env: Record<string, string>): string[] {
  const values = new Set<string>()
  const visit = (object: Record<string, unknown>, depth = 0): void => {
    if (depth > 12) return
    for (const [key, value] of Object.entries(object)) {
      if (typeof value === 'string' && /token|secret|password|credential|api.?key|authorization/i.test(key)) {
        if (value.length >= 4) values.add(value)
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, depth + 1)
      }
    }
  }
  const merged = { ...process.env, ...env }
  visit(merged)
  if (merged.OPENCODE_CONFIG_CONTENT) {
    try { visit(JSON.parse(merged.OPENCODE_CONFIG_CONTENT)) } catch { /* Validation is owned by fullAccessEnvironment. */ }
  }
  return [...values].sort((a, b) => b.length - a.length)
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-opencode: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-opencode: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-opencode: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed range, and wait for the
 * subprocess owner to prove it is quiescent.
 * @param wire - private ACP protocol connection.
 * @param child - shared-service handle that owns the managed range.
 */
export async function disposeOpenCodeChild(
  wire: OpenCodeAcpWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()

  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change range ownership below.
  }
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    throw new OpenCodeRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, thrown(error))
  }
  await child.done.catch(() => {})
}

/**
 * Start the existing `opencode acp` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after initialization and fresh session creation.
 */
export async function startOpenCodeRun(
  request: SubagentStartRequest,
  spec: OpenCodeRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  const secrets = diagnosticSecrets(spec.env)
  if (request.signal.aborted) {
    throw new Error('subagent-opencode: request was aborted before ACP startup')
  }

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: opencodeAcpArgv(spec.command, spec.cwd, spec.env),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: fullAccessEnvironment(spec.env, spec.agent),
    })
  } catch (error: unknown) {
    throw new OpenCodeRunFailure({
      stage: 'initialize',
      category: 'unknown',
    }, thrown(error))
  }

  const wire = new OpenCodeAcpWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    { model: spec.model, agent: spec.agent, secrets },
  )
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary. JSON-RPC and child.done remain the
    // only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async (): Promise<void> => {
    let sessionCleanupError: unknown
    try {
      try {
        await wire.releaseSession(spec.deleteSession, Math.ceil(spec.disposeGraceMs))
      } catch (error: unknown) {
        sessionCleanupError = error
      }
      await disposeOpenCodeChild(wire, child)
      // Let stderr already queued by the process close reach the Host before
      // its forwarding listeners are detached.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      if (sessionCleanupError !== undefined) {
        throw new OpenCodeRunFailure({ stage: 'teardown', category: 'unknown' }, sessionCleanupError)
      }
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts: OpenCodeFailureFacts | undefined
  const processFailure: Promise<never> = child.done.then<never>(
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new OpenCodeRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new OpenCodeRunFailure(processFailureFacts, thrown(error))
    },
  )
  // A normal post-result dispose also closes the process. Keep its expected
  // late rejection observed when the terminal result settles first.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-opencode: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let startupStage: 'initialize' | 'session-new' = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    startupStage = 'session-new'
    await Promise.race([wire.startSession(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof OpenCodeRunFailure) && !cancelledBeforeCleanup) {
      // Node reports stdout EOF before the child close that owns its outcome.
      // Let an already-exiting process publish those facts before rollback.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    const wireFacts = wire.collectFailure()
    const nativeFacts = error instanceof OpenCodeRunFailure ? error.facts
      : wireFacts.category !== 'unknown' || wireFacts.rpcCode !== undefined ? wireFacts
      : { ...failureFacts(error, startupStage, secrets), ...(wireFacts.model === undefined ? {} : { model: wireFacts.model }) }
    const failure = new OpenCodeRunFailure({
      ...nativeFacts,
      outcome: error instanceof OpenCodeRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('subagent-opencode: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('subagent-opencode: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  let diagnostic: string | undefined
  const recordFailureDiagnostic = (facts: OpenCodeFailureFacts): string => {
    const failure = failureDiagnostic(facts)
    const permission = wire.collectDiagnostic()
    diagnostic = permission === undefined
      ? failure
      : `${failure}\n${permission}`
    return diagnostic
  }
  const withProcessOutcome = (facts: OpenCodeFailureFacts): OpenCodeFailureFacts => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error: unknown): Promise<never> => {
      // Frames already queued by the exiting ACP remain authoritative.
      // One I/O turn lets them settle before process exit ends the run.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return { ...terminal, diagnostic: wire.collectMetadata() }
        // Let stderr already queued with the terminal frame reach the Host
        // before the non-completed result settles.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const facts = withProcessOutcome(wire.collectFailure())
        return { ...terminal, diagnostic: recordFailureDiagnostic(facts) }
      } catch (error: unknown) {
        // Give stderr data already queued in Node one turn to reach the Host
        // before error settlement.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // The wire failure remains authoritative when exit observation fails.
          }
        }
        const facts = error instanceof OpenCodeRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof OpenCodeRunFailure
          ? error
          : new OpenCodeRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}

