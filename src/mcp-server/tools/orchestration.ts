import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http-client';

function asText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerOrchestrationTools(server: McpServer, http: HttpClient): void {
  server.tool(
    'project_list',
    'List projects Emdash knows about. Use this to discover projectIds for task_list and task_create.',
    {
      includeArchived: z.boolean().optional(),
    },
    async ({ includeArchived }) =>
      asText(await http.get('/projects', includeArchived ? { includeArchived: true } : undefined))
  );

  server.tool(
    'task_list',
    "List tasks. Defaults to the caller's project; pass projectId to inspect another project.",
    {
      projectId: z.string().optional(),
      includeArchived: z.boolean().optional(),
    },
    async ({ projectId, includeArchived }) =>
      asText(
        await http.get('/tasks', {
          ...(projectId ? { projectId } : {}),
          ...(includeArchived ? { includeArchived: true } : {}),
        })
      )
  );

  server.tool(
    'task_create',
    "Create a new task, optionally seeded with an initial conversation. Defaults to the caller's project and the project's baseRef.",
    {
      projectId: z.string().optional(),
      name: z.string(),
      strategy: z.literal('new-branch').optional(),
      sourceBranch: z.string().optional(),
      taskBranch: z.string().optional(),
      providerId: z.string().optional(),
      initialPrompt: z.string().optional(),
    },
    async (params) => asText(await http.post('/tasks', params))
  );

  server.tool(
    'workspace_dev_servers',
    "List dev server URLs detected from terminals in the caller's task.",
    {},
    async () => asText(await http.get('/workspace/dev-servers'))
  );

  server.tool('terminal_list', "List terminals open in the caller's task.", {}, async () =>
    asText(await http.get('/terminals'))
  );

  server.tool(
    'terminal_send',
    'Append text to a terminal. With submit=true, also sends Enter so the command runs.',
    {
      terminalId: z.string(),
      text: z.string(),
      submit: z.boolean().optional(),
    },
    async ({ terminalId, text, submit }) =>
      asText(
        await http.post(`/terminals/${encodeURIComponent(terminalId)}/send`, {
          text,
          ...(submit !== undefined ? { submit } : {}),
        })
      )
  );

  server.tool(
    'terminal_create',
    "Open a new terminal in the caller's task worktree. initialCommand is typed and submitted after spawn.",
    {
      initialCommand: z.string().optional(),
      name: z.string().optional(),
    },
    async (params) => asText(await http.post('/terminals', params))
  );
}
