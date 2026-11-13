import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
export declare const name = "subagent-opencode";
export declare const inject: string[];
export interface Config {
  providerName?: string;
  command?: string;
  model?: string;
  agent?: string;
  env?: Record<string, string>;
  permissionMode?: 'full-access';
  disposeGraceMs?: number;
  deleteSession?: boolean;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
