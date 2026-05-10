/**
 * emdash-mcp identity — read EMDASH_* env vars set by emdash at PTY spawn.
 * If any required var is missing, the subprocess refuses to register tools
 * and exits cleanly so the host CLI doesn't hang.
 */

export type Identity = {
  instanceId: string;
  sessionId: string;
  taskId: string;
  projectId: string;
  statusUrl: string;
  token: string;
};

const ENV_MAP = {
  EMDASH_INSTANCE_ID: 'instanceId',
  EMDASH_SESSION_ID: 'sessionId',
  EMDASH_TASK_ID: 'taskId',
  EMDASH_PROJECT_ID: 'projectId',
  EMDASH_STATUS_URL: 'statusUrl',
  EMDASH_TOKEN: 'token',
} as const satisfies Record<string, keyof Identity>;

export class IdentityError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(`emdash-mcp: missing required env vars: ${missing.join(', ')}`);
    this.name = 'IdentityError';
  }
}

export function loadIdentity(env: NodeJS.ProcessEnv = process.env): Identity {
  const out: Partial<Identity> = {};
  const missing: string[] = [];
  for (const [envKey, field] of Object.entries(ENV_MAP) as Array<
    [keyof typeof ENV_MAP, (typeof ENV_MAP)[keyof typeof ENV_MAP]]
  >) {
    const value = env[envKey];
    if (!value) {
      missing.push(envKey);
      continue;
    }
    out[field] = value;
  }
  if (missing.length > 0) {
    throw new IdentityError(missing);
  }
  return out as Identity;
}
