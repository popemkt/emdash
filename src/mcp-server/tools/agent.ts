import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http-client';

function asText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerAgentTools(server: McpServer, http: HttpClient): void {
  server.tool(
    'agent_self',
    "Return the calling agent's Emdash conversation, task, project, provider, and display name.",
    {},
    async () => asText(await http.get('/agent/self'))
  );

  server.tool(
    'agent_list_peers',
    'List peer agents visible to the caller. Default scope is the same task; project/all are wider read-only views unless a write tool opts into crossTask.',
    {
      scope: z.enum(['task', 'project', 'all']).optional(),
    },
    async ({ scope }) => asText(await http.get('/agent/peers', scope ? { scope } : undefined))
  );

  server.tool(
    'agent_spawn',
    'Spawn a new peer conversation in the same Emdash task. The new conversation is created through normal Emdash state so it appears in the UI.',
    {
      providerId: z.string(),
      name: z.string().optional(),
      initialPrompt: z.string().optional(),
    },
    async ({ providerId, name, initialPrompt }) =>
      asText(
        await http.post('/agent/spawn', {
          providerId,
          ...(name ? { name } : {}),
          ...(initialPrompt ? { initialPrompt } : {}),
        })
      )
  );

  server.tool(
    'agent_observe',
    "Return a peer agent's current status, recent events, and last assistant message when available. waitForChange long-polls until the peer changes state or times out.",
    {
      conversationId: z.string(),
      waitForChange: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    },
    async ({ conversationId, waitForChange, timeoutMs }) =>
      asText(
        await http.get(`/agent/${encodeURIComponent(conversationId)}/observe`, {
          ...(waitForChange ? { waitForChange: true } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        })
      )
  );

  server.tool(
    'agent_fetch',
    "Fetch peer agent data. kind='events' returns structured recent agent events, kind='scrollback' returns raw PTY ring buffer text, and kind='transcript' returns provider transcript items when the provider exposes a session id.",
    {
      conversationId: z.string(),
      kind: z.enum(['events', 'scrollback', 'transcript']).optional(),
      limit: z.number().int().positive().optional(),
      since: z.string().optional(),
    },
    async ({ conversationId, kind, limit, since }) =>
      asText(
        await http.get(`/agent/${encodeURIComponent(conversationId)}/fetch`, {
          ...(kind ? { kind } : {}),
          ...(limit ? { limit } : {}),
          ...(since ? { since } : {}),
        })
      )
  );

  server.tool(
    'agent_send',
    "Send text to a peer agent's PTY. submit=true, the default, presses Enter after typing. submit=false stages a draft in the target UI.",
    {
      conversationId: z.string(),
      message: z.string(),
      submit: z.boolean().optional(),
      crossTask: z.boolean().optional(),
    },
    async ({ conversationId, message, submit, crossTask }) =>
      asText(
        await http.post(`/agent/${encodeURIComponent(conversationId)}/send`, {
          message,
          ...(submit !== undefined ? { submit } : {}),
          ...(crossTask !== undefined ? { crossTask } : {}),
        })
      )
  );

  server.tool(
    'agent_interrupt',
    "Send Ctrl-C to a peer agent's PTY without killing the session.",
    {
      conversationId: z.string(),
      crossTask: z.boolean().optional(),
    },
    async ({ conversationId, crossTask }) =>
      asText(
        await http.post(`/agent/${encodeURIComponent(conversationId)}/interrupt`, {
          ...(crossTask !== undefined ? { crossTask } : {}),
        })
      )
  );
}
