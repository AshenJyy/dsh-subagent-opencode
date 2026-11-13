/** OpenCode product provider; shared seams match dsh-subagent-codex 0.2.2-rc.3. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  assertUsableCwd,
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { startOpenCodeRun, opencodeStartupFailure, DEFAULT_DISPOSE_GRACE_MS } from './run.ts'

export const name = 'subagent-opencode'
export const inject = ['subagents', 'subprocess']

export interface Config {
  providerName?: string
  /** Existing executable or Node CLI script. Never installed or version-probed. */
  command?: string
  /** Optional native model; omitted to inherit OpenCode's model selection. */
  model?: string
  /** Native primary agent. Build is the full-access default. */
  agent?: string
  env?: Record<string, string>
  permissionMode?: 'full-access'
  /** Cleanup grace only, not a wall-clock task timeout. */
  disposeGraceMs?: number
  /** Remove only this provider-created session when ACP supports deletion. */
  deleteSession?: boolean
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('opencode'),
  command: z.string().min(1).default('opencode'),
  model: z.string().min(1),
  agent: z.string().min(1).default('build'),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union(['full-access']).default('full-access'),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  deleteSession: z.boolean().default(true),
})

type ResolvedConfig = Required<Omit<Config, 'model'>> & Pick<Config, 'model'>

class OpenCodeProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly name: string
  private readonly ctx: Context
  private readonly config: ResolvedConfig

  constructor(
    name: string,
    ctx: Context,
    config: ResolvedConfig,
  ) {
    this.name = name
    this.ctx = ctx
    this.config = config
  }

  start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-opencode', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) throw new Error('subagent-opencode: request aborted before startup')
      throw opencodeStartupFailure(error)
    }
    return startOpenCodeRun(request, {
      ...this.config,
      cwd,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error, reason) => {
        this.ctx.logger.warn(`subagent-opencode "${this.name}": child run failed (${reason}): ${error.message}`)
      },
    })
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? 'opencode',
    command: config.command ?? 'opencode',
    ...(config.model === undefined ? {} : { model: config.model }),
    agent: config.agent ?? 'build',
    env: config.env ?? {},
    permissionMode: config.permissionMode ?? 'full-access',
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    deleteSession: config.deleteSession ?? true,
  }
  assertPositiveFinite(name, 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-opencode: disposeGraceMs must be <= ${MAX_TIMER_DELAY_MS}`)
  }
  if (resolved.permissionMode !== 'full-access') throw new Error('subagent-opencode: unsupported permission mode')
  ctx.subagents.registerProvider(new OpenCodeProvider(resolved.providerName, ctx, resolved))
}
