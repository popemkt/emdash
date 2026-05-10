import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { z } from 'zod';
import type { HttpClient } from '../http-client';

/**
 * Set A — agent collaboration tools.
 *
 * Three tools land in PR1: agent_self, agent_observe, agent_send.
 * The remaining five (list_peers, spawn, interrupt, fetch, close) follow in PR2.
 */

type ToolHandler<TShape extends ZodRawShapeCompat> = (
  params: ShapeOutput<TShape>,
  http: HttpClient
) => Promise<unknown>;

type ToolDef = {
  name: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  handler: (params: unknown, http: HttpClient) => Promise<unknown>;
};

/**
 * Type-narrowed tool builder. Each call captures `TShape` so the handler body
 * sees the inferred params (e.g. `{conversationId: string}`), then we widen at
 * the boundary so the resulting defs share a single `ToolDef` type and live
 * in one table. SDK validates params against `inputSchema` before invoking.
 */
function defineTool<TShape extends ZodRawShapeCompat>(spec: {
  name: string;
  description: string;
  inputSchema: TShape;
  handler: ToolHandler<TShape>;
}): ToolDef {
  return spec as unknown as ToolDef;
}

const agentTools: readonly ToolDef[] = [
  defineTool({
    name: 'agent_self',
    description:
      "Returns the calling agent's identity within emdash: conversationId, taskId, projectId, providerId, name.",
    inputSchema: {},
    handler: (_params, http) => http.get('/agent/self'),
  }),
  defineTool({
    name: 'agent_observe',
    description:
      "Returns a peer agent's current status, recent events, and (when supported by the provider) the last assistant message. Optionally long-polls until the status changes.",
    inputSchema: {
      conversationId: z
        .string()
        .describe(
          'Target conversation ID. Use agent_self to discover own ID, or agent_list_peers (PR2).'
        ),
      waitForChange: z
        .boolean()
        .optional()
        .describe("If true, block until the target's status transitions or timeoutMs elapses."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe('Long-poll timeout in milliseconds. Default 30000.'),
    },
    handler: ({ conversationId, waitForChange, timeoutMs }, http) =>
      http.get(`/agent/${conversationId}/observe`, {
        ...(waitForChange ? { waitForChange: true } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
  }),
  defineTool({
    name: 'agent_send',
    description:
      "Sends a message to a peer agent's PTY (like typing into their terminal). Same-task only by default; pass crossTask=true for cross-task delivery (capability-gated).",
    inputSchema: {
      conversationId: z.string().describe('Target conversation ID.'),
      message: z
        .string()
        .describe("Text to inject into target's stdin. A trailing newline is added automatically."),
      crossTask: z
        .boolean()
        .optional()
        .describe(
          'Set true to allow delivery to a conversation in a different task. Server returns 403 if the cross-task:write capability is disabled.'
        ),
    },
    handler: ({ conversationId, message, crossTask }, http) =>
      http.post(`/agent/${conversationId}/send`, {
        message,
        ...(crossTask !== undefined ? { crossTask } : {}),
      }),
  }),
];

export function registerAgentTools(server: McpServer, http: HttpClient): void {
  for (const def of agentTools) {
    server.tool(def.name, def.description, def.inputSchema, async (params) => {
      const data = await def.handler(params, http);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    });
  }
}
