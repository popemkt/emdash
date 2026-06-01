import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { createTask } from '@main/core/tasks/operations/createTask';
import { getTasks } from '@main/core/tasks/operations/getTasks';
import { createTerminal } from '@main/core/terminals/createTerminal';
import { getTerminalsForTask } from '@main/core/terminals/getTerminalsForTask';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import { isValidProviderId, type AgentProviderId } from '@shared/agent-provider-registry';
import type { Branch } from '@shared/git';
import { makePtySessionId } from '@shared/ptySessionId';
import type { CreateTaskError } from '@shared/tasks';
import type { DevServerTracker } from '../dev-server-tracker';
import { HttpError, type CallerContext } from '../http-server';

export const TaskCreateBodySchema = z
  .object({
    projectId: z.string().optional(),
    name: z.string().min(1),
    sourceBranch: z.string().optional(),
    taskBranch: z.string().optional(),
    initialPrompt: z.string().optional(),
    providerId: z.string().optional(),
    strategy: z.literal('new-branch').optional(),
  })
  .refine((value) => !value.initialPrompt || value.providerId, {
    message: 'initialPrompt requires providerId',
    path: ['initialPrompt'],
  });
export type TaskCreateBody = z.infer<typeof TaskCreateBodySchema>;

export const TerminalCreateBodySchema = z.object({
  initialCommand: z.string().optional(),
  name: z.string().optional(),
});
export type TerminalCreateBody = z.infer<typeof TerminalCreateBodySchema>;

export const TerminalSendBodySchema = z.object({
  text: z.string(),
  submit: z.boolean().optional(),
});
export type TerminalSendBody = z.infer<typeof TerminalSendBodySchema>;

export const TaskListQuerySchema = z.object({
  projectId: z.string().optional(),
  includeArchived: z.boolean().optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

export const ProjectListQuerySchema = z.object({
  includeArchived: z.boolean().optional(),
});
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;

function createTaskErrorToHttp(error: CreateTaskError): HttpError {
  switch (error.type) {
    case 'project-not-found':
      return new HttpError(404, 'project not found');
    case 'branch-not-found':
      return new HttpError(400, `source branch not found: ${error.branch}`);
    case 'initial-commit-required':
      return new HttpError(409, `repository unborn: ${error.branch} has no commits`);
    case 'branch-create-failed':
      return new HttpError(409, `branch create failed: ${error.branch}`);
    case 'pr-fetch-failed':
      return new HttpError(502, `pr fetch failed from ${error.remote}`);
    case 'worktree-setup-failed':
      return new HttpError(500, `worktree setup failed: ${error.branch}`);
  }
}

async function lookupProjectNames(projectIds: string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function handleTaskList(caller: CallerContext, query: TaskListQuery) {
  const projectId = query.projectId ?? caller.conversation.projectId;
  const tasks = await getTasks(projectId);
  const filtered = query.includeArchived ? tasks : tasks.filter((task) => !task.archivedAt);
  const projectNames = await lookupProjectNames(
    Array.from(new Set(filtered.map((task) => task.projectId)))
  );

  return filtered.map((task) => ({
    id: task.id,
    projectId: task.projectId,
    projectName: projectNames.get(task.projectId),
    name: task.name,
    status: task.status,
    taskBranch: task.taskBranch,
    archivedAt: task.archivedAt,
    lastInteractedAt: task.lastInteractedAt,
  }));
}

export async function handleTaskCreate(caller: CallerContext, body: TaskCreateBody) {
  const projectId = body.projectId ?? caller.conversation.projectId;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new HttpError(404, 'project not found');

  const sourceBranchName = body.sourceBranch ?? project.baseRef;
  if (!sourceBranchName) {
    throw new HttpError(400, 'sourceBranch required: project has no baseRef configured');
  }

  let provider: AgentProviderId | undefined;
  if (body.providerId) {
    if (!isValidProviderId(body.providerId)) throw new HttpError(400, 'invalid providerId');
    provider = body.providerId;
  }

  const taskId = randomUUID();
  const conversationId = provider ? randomUUID() : undefined;
  const sourceBranch: Branch = { type: 'local', branch: sourceBranchName };
  const result = await createTask({
    id: taskId,
    projectId,
    name: body.name,
    sourceBranch,
    strategy: {
      kind: 'new-branch',
      taskBranch: body.taskBranch ?? body.name,
    },
    initialConversation:
      provider && conversationId
        ? {
            id: conversationId,
            projectId,
            taskId,
            provider,
            title: body.name,
            initialPrompt: body.initialPrompt,
            isInitialConversation: true,
          }
        : undefined,
  });

  if (!result.success) throw createTaskErrorToHttp(result.error);

  return {
    taskId: result.data.task.id,
    taskName: result.data.task.name,
    taskBranch: result.data.task.taskBranch,
    projectId: result.data.task.projectId,
    conversationId,
  };
}

export async function handleProjectList(_caller: CallerContext, query: ProjectListQuery) {
  const rows = await db.select().from(projects);
  const filtered = query.includeArchived ? rows : rows.filter((project) => !project.archived);
  return filtered.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.path,
    baseRef: project.baseRef,
    archived: project.archived,
  }));
}

export async function handleTerminalList(caller: CallerContext) {
  const list = await getTerminalsForTask(caller.conversation.projectId, caller.conversation.taskId);
  return list.map((terminal) => ({
    id: terminal.id,
    taskId: terminal.taskId,
    projectId: terminal.projectId,
    name: terminal.name,
  }));
}

export async function handleTerminalSend(
  caller: CallerContext,
  terminalId: string,
  body: TerminalSendBody
): Promise<{ ok: true }> {
  const sessionId = makePtySessionId(
    caller.conversation.projectId,
    caller.conversation.taskId,
    terminalId
  );
  const pty = ptySessionRegistry.get(sessionId);
  if (!pty) throw new HttpError(410, 'terminal not running');

  pty.write(body.text);
  if (body.submit) pty.write('\r');
  return { ok: true };
}

export async function handleTerminalCreate(
  caller: CallerContext,
  body: TerminalCreateBody
): Promise<{ terminalId: string; name: string }> {
  const terminal = await createTerminal({
    id: randomUUID(),
    projectId: caller.conversation.projectId,
    taskId: caller.conversation.taskId,
    name: body.name ?? 'Agent terminal',
  });

  if (body.initialCommand) {
    const sessionId = makePtySessionId(
      caller.conversation.projectId,
      caller.conversation.taskId,
      terminal.id
    );
    const pty = ptySessionRegistry.get(sessionId);
    if (!pty) throw new HttpError(500, 'pty failed to register after spawn');
    pty.write(body.initialCommand);
    pty.write('\r');
  }

  return { terminalId: terminal.id, name: terminal.name };
}

export function handleWorkspaceDevServers(caller: CallerContext, tracker: DevServerTracker) {
  return {
    servers: tracker.listForTask(caller.conversation.taskId).map((entry) => ({
      terminalId: entry.terminalId,
      url: entry.url,
      detectedAt: entry.detectedAt,
    })),
  };
}
