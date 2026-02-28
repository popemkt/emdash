import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../main/services/DatabaseService';
import { WorkflowService } from '../../main/services/WorkflowService';

const getTaskByIdMock = vi.fn();
const saveTaskMock = vi.fn();
const createConversationMock = vi.fn();
const saveConversationMock = vi.fn();
const setActiveConversationMock = vi.fn();

vi.mock('../../main/services/DatabaseService', () => ({
  databaseService: {
    getTaskById: (...args: any[]) => getTaskByIdMock(...args),
    saveTask: (...args: any[]) => saveTaskMock(...args),
    createConversation: (...args: any[]) => createConversationMock(...args),
    saveConversation: (...args: any[]) => saveConversationMock(...args),
    setActiveConversation: (...args: any[]) => setActiveConversationMock(...args),
  },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  const timestamp = new Date().toISOString();
  return {
    id: 'task-agent-scope',
    projectId: 'project-1',
    name: 'Scoped Workflow Task',
    branch: 'emdash/task-agent-scope',
    path: '/tmp/task-agent-scope',
    status: 'active',
    agentId: 'codex',
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('WorkflowService scoped plans', () => {
  let service: WorkflowService;
  let tmpDir: string;
  let storedTask: Task;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WorkflowService();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-workflow-'));
    storedTask = makeTask({ path: tmpDir });

    getTaskByIdMock.mockImplementation(async (taskId: string) => {
      return taskId === storedTask.id ? storedTask : null;
    });
    saveTaskMock.mockImplementation(async (nextTask: Task) => {
      storedTask = nextTask;
    });
    createConversationMock.mockResolvedValue({
      id: 'conv-1',
      taskId: storedTask.id,
      title: 'Step 1',
      provider: 'codex',
      isMain: false,
      isActive: false,
      displayOrder: 1,
      metadata: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    saveConversationMock.mockResolvedValue(undefined);
    setActiveConversationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores scoped workflows under .zenflow/<taskId>/<scope>/plan.md', async () => {
    const workflow = await service.createWorkflow({
      taskId: storedTask.id,
      template: 'spec-and-build',
      featureDescription: 'Implement scoped workflow',
      scopeKey: 'codex',
    });

    expect(workflow.scopeKey).toBe('codex');
    expect(workflow.planRelPath).toBe('.zenflow/task-agent-scope/codex/plan.md');
    expect(workflow.artifactsDirRelPath).toBe('.zenflow/task-agent-scope/codex');
    expect(fs.existsSync(path.join(tmpDir, workflow.planRelPath))).toBe(true);

    const metadata = storedTask.metadata as Record<string, any>;
    expect(metadata.workflows?.codex).toBeTruthy();
    expect(metadata.workflow).toBeFalsy();
  });

  it('keeps workflow plans isolated per agent scope', async () => {
    await service.createWorkflow({
      taskId: storedTask.id,
      template: 'spec-and-build',
      featureDescription: 'Codex scoped',
      scopeKey: 'codex',
    });
    await service.createWorkflow({
      taskId: storedTask.id,
      template: 'spec-and-build',
      featureDescription: 'Claude scoped',
      scopeKey: 'claude',
    });

    const codexPlanPath = path.join(tmpDir, '.zenflow/task-agent-scope/codex/plan.md');
    const originalCodexPlan = fs.readFileSync(codexPlanPath, 'utf8');
    const mutatedCodexPlan = originalCodexPlan.replace(
      'Step 1: Technical Spec',
      'Step 1: Codex Custom Spec'
    );
    fs.writeFileSync(codexPlanPath, mutatedCodexPlan, 'utf8');

    const codexWorkflow = await service.getWorkflow(storedTask.id, 'codex');
    const claudeWorkflow = await service.getWorkflow(storedTask.id, 'claude');

    expect(codexWorkflow?.steps[0]?.title).toBe('Codex Custom Spec');
    expect(claudeWorkflow?.steps[0]?.title).toBe('Technical Spec');
    expect(codexWorkflow?.planRelPath).toBe('.zenflow/task-agent-scope/codex/plan.md');
    expect(claudeWorkflow?.planRelPath).toBe('.zenflow/task-agent-scope/claude/plan.md');
  });
});
