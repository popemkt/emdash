import fs from 'node:fs';
import path from 'node:path';
import { databaseService, type Task } from './DatabaseService';
import type {
  WorkflowAutoMode,
  WorkflowState,
  WorkflowStep,
  WorkflowStepConversationMetadata,
  WorkflowStepStatus,
  WorkflowTemplate,
} from '@shared/workflow/types';

const WORKFLOW_ROOT_REL = '.emdash';
const CHAT_ID_COMMENT = /^\s*<!--\s*emdash:chat-id=(.*?)\s*-->\s*$/;
const STEP_ID_COMMENT = /^\s*<!--\s*emdash:step-id=(.*?)\s*-->\s*$/;
const PAUSE_COMMENT = /^\s*<!--\s*emdash:pause-point=(true|false)\s*-->\s*$/;
const DEFAULT_SCOPE_KEY = 'default';

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function nowIso(): string {
  return new Date().toISOString();
}

type StepSeed = {
  number: number;
  title: string;
  instructions: string;
  pausePoint: boolean;
  artifacts: string[];
};

type WorkflowStorage = Record<string, WorkflowState>;

function buildTemplateSteps(template: WorkflowTemplate): StepSeed[] {
  if (template === 'simple-prompt') {
    return [
      {
        number: 1,
        title: 'Implementation',
        instructions:
          'Implement the requested change directly. Summarize completed work and open items in report.md.',
        pausePoint: false,
        artifacts: ['report.md'],
      },
    ];
  }

  if (template === 'spec-and-build') {
    return [
      {
        number: 1,
        title: 'Technical Spec',
        instructions:
          'Analyze the feature and write a technical specification to spec.md. Include architecture, affected files, risks, and rollout notes.',
        pausePoint: true,
        artifacts: ['spec.md'],
      },
      {
        number: 2,
        title: 'Implementation',
        instructions:
          'Implement the feature based on spec.md. Summarize completed work and open items in report.md.',
        pausePoint: false,
        artifacts: ['report.md'],
      },
    ];
  }

  return [
    {
      number: 1,
      title: 'Requirements',
      instructions:
        'Clarify and document requirements in requirements.md. Capture assumptions and questions for user confirmation.',
      pausePoint: true,
      artifacts: ['requirements.md'],
    },
    {
      number: 2,
      title: 'Technical Spec',
      instructions: 'Produce a technical specification in spec.md using requirements.md as input.',
      pausePoint: false,
      artifacts: ['spec.md'],
    },
    {
      number: 3,
      title: 'Planning',
      instructions:
        'Expand plan.md into concrete implementation steps. Keep each new step coherent and executable in a single focused chat.',
      pausePoint: true,
      artifacts: ['plan.md'],
    },
  ];
}

function statusToMarker(status: WorkflowStepStatus): string {
  if (status === 'completed') return 'x';
  if (status === 'blocked') return '!';
  if (status === 'in_progress') return '>';
  return ' ';
}

function markerToStatus(marker: string): WorkflowStepStatus {
  if (marker === 'x') return 'completed';
  if (marker === '!') return 'blocked';
  if (marker === '>') return 'in_progress';
  return 'pending';
}

function parseJsonObject(raw: string | null | undefined): Record<string, any> {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function buildStepId(number: number, title: string): string {
  return `step-${number}-${slugify(title || `step-${number}`) || `step-${number}`}`;
}

function isWorkflowState(value: unknown): value is WorkflowState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkflowState>;
  return candidate.enabled === true && Array.isArray(candidate.steps);
}

function normalizeScopeKey(scopeKey?: string): string {
  const input = typeof scopeKey === 'string' ? scopeKey.trim() : '';
  const normalized = (input || DEFAULT_SCOPE_KEY)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_SCOPE_KEY;
}

function normalizeLegacyScopeKey(scopeKey?: string): string {
  const input = typeof scopeKey === 'string' ? scopeKey.trim() : '';
  const normalized = slugify(input || DEFAULT_SCOPE_KEY);
  return normalized || DEFAULT_SCOPE_KEY;
}

function resolveWorkflowPaths(
  taskId: string,
  scopeKey: string
): {
  baseDirRelPath: string;
  scopeDirRelPath: string;
  planRelPath: string;
} {
  const taskSlug = slugify(taskId) || 'task';
  const baseDirRelPath = path.posix.join(WORKFLOW_ROOT_REL, taskSlug);
  const scopeDirRelPath =
    scopeKey === DEFAULT_SCOPE_KEY
      ? baseDirRelPath
      : path.posix.join(baseDirRelPath, normalizeScopeKey(scopeKey));
  const planRelPath = path.posix.join(scopeDirRelPath, 'plan.md');
  return {
    baseDirRelPath,
    scopeDirRelPath,
    planRelPath,
  };
}

export class WorkflowService {
  private getWorkflowStorage(task: Task): WorkflowStorage {
    const workflows = task.metadata?.workflows;
    if (!workflows || typeof workflows !== 'object') return {};

    const out: WorkflowStorage = {};
    for (const [key, value] of Object.entries(workflows as Record<string, unknown>)) {
      if (!isWorkflowState(value)) continue;
      out[normalizeScopeKey(key)] = value;
    }
    return out;
  }

  private getWorkflowFromTask(task: Task, scopeKey?: string): WorkflowState | null {
    const normalizedScope = normalizeScopeKey(scopeKey);
    const workflows = this.getWorkflowStorage(task);
    if (workflows[normalizedScope]) return workflows[normalizedScope];
    const legacyScope = normalizeLegacyScopeKey(scopeKey);
    if (legacyScope !== normalizedScope && workflows[legacyScope]) return workflows[legacyScope];

    // Backward compatibility for early workflow metadata shape.
    if (normalizedScope === DEFAULT_SCOPE_KEY && isWorkflowState(task.metadata?.workflow)) {
      return task.metadata.workflow as WorkflowState;
    }

    return null;
  }

  private async getTaskOrThrow(taskId: string): Promise<Task> {
    const task = await databaseService.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private withWorkflowMetadata(task: Task, scopeKey: string, workflow: WorkflowState): Task {
    const normalizedScope = normalizeScopeKey(scopeKey);
    const legacyScope = normalizeLegacyScopeKey(scopeKey);
    const existing = this.getWorkflowStorage(task);
    const nextStorage: WorkflowStorage = {
      ...existing,
      [normalizedScope]: workflow,
    };
    if (legacyScope !== normalizedScope && legacyScope in nextStorage) {
      delete nextStorage[legacyScope];
    }

    const metadata = {
      ...(task.metadata || {}),
      workflows: nextStorage,
      // Keep legacy field aligned for default scope.
      ...(normalizedScope === DEFAULT_SCOPE_KEY ? { workflow } : {}),
    };

    return {
      ...task,
      metadata,
    };
  }

  private async persistTaskWorkflow(
    task: Task,
    scopeKey: string,
    workflow: WorkflowState
  ): Promise<WorkflowState> {
    const nextTask = this.withWorkflowMetadata(task, scopeKey, workflow);
    await databaseService.saveTask(nextTask);
    return workflow;
  }

  private resolveTaskPath(task: Task, taskPathOverride?: string): string {
    const override = typeof taskPathOverride === 'string' ? taskPathOverride.trim() : '';
    if (override) return override;
    return task.path;
  }

  private ensureWorkflowDir(taskPath: string, workflow: WorkflowState): string {
    const abs = path.join(taskPath, workflow.artifactsDirRelPath);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }

  private planAbsPath(taskPath: string, workflow: WorkflowState): string {
    return path.join(taskPath, workflow.planRelPath);
  }

  private renderPlanMarkdown(workflow: WorkflowState): string {
    const lines: string[] = [];
    lines.push('# Workflow Plan');
    lines.push('');
    lines.push(`Feature: ${workflow.featureDescription}`);
    lines.push(`Scope: ${workflow.scopeKey}`);
    lines.push(`Template: ${workflow.type}`);
    lines.push(`Status: ${workflow.status}`);
    lines.push(`Auto Mode: ${workflow.autoMode}`);
    lines.push(`Updated: ${workflow.updatedAt}`);
    lines.push('');
    lines.push('## Steps');

    for (const step of workflow.steps) {
      lines.push(`- [${statusToMarker(step.status)}] Step ${step.number}: ${step.title}`);
      lines.push(`  <!-- emdash:chat-id=${step.conversationId || ''} -->`);
      lines.push(`  <!-- emdash:step-id=${step.id} -->`);
      lines.push(`  <!-- emdash:pause-point=${step.pausePoint ? 'true' : 'false'} -->`);
      if (step.artifacts.length > 0) {
        lines.push(`  Artifacts: ${step.artifacts.join(', ')}`);
      }
      lines.push('');
    }

    lines.push('## Notes');
    lines.push('- Chat IDs are persisted in the comment line below each step.');
    lines.push('');

    return lines.join('\n');
  }

  private writePlanFile(taskPath: string, workflow: WorkflowState): void {
    this.ensureWorkflowDir(taskPath, workflow);
    fs.writeFileSync(
      this.planAbsPath(taskPath, workflow),
      this.renderPlanMarkdown(workflow),
      'utf8'
    );
  }

  private parsePlanMarkdown(markdown: string, existing: WorkflowState): WorkflowState {
    const lines = markdown.split(/\r?\n/);
    const existingById = new Map(existing.steps.map((s) => [s.id, s]));
    const existingByNumber = new Map(existing.steps.map((s) => [s.number, s]));
    const parsedSteps: WorkflowStep[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const match = line.match(/^\s*-\s*\[([ x!>])\]\s*Step\s+(\d+)\s*:\s*(.+?)\s*$/);
      if (!match) continue;

      const marker = match[1];
      const number = Number(match[2]);
      const title = match[3].trim();

      let chatId: string | null = null;
      let stepId: string | null = null;
      let pausePoint = false;

      let j = i + 1;
      while (j < lines.length && /^\s{2,}/.test(lines[j])) {
        const sub = lines[j].trim();
        const chatMatch = sub.match(CHAT_ID_COMMENT);
        if (chatMatch) {
          const value = (chatMatch[1] || '').trim();
          chatId = value || null;
        }
        const idMatch = sub.match(STEP_ID_COMMENT);
        if (idMatch) {
          const value = (idMatch[1] || '').trim();
          stepId = value || null;
        }
        const pauseMatch = sub.match(PAUSE_COMMENT);
        if (pauseMatch) {
          pausePoint = pauseMatch[1] === 'true';
        }
        j++;
      }
      i = j - 1;

      const fallbackId = buildStepId(number, title);
      const id = stepId || fallbackId;
      const existingStep = existingById.get(id) || existingByNumber.get(number);

      parsedSteps.push({
        id,
        number,
        title,
        instructions: existingStep?.instructions || `Implement: ${title}`,
        status: markerToStatus(marker),
        pausePoint: existingStep?.pausePoint ?? pausePoint,
        conversationId: chatId ?? existingStep?.conversationId ?? null,
        artifacts: existingStep?.artifacts || [],
        startedAt: existingStep?.startedAt,
        completedAt: existingStep?.completedAt,
      });
    }

    if (parsedSteps.length === 0) {
      return existing;
    }

    const currentStep = parsedSteps.find((s) => s.status === 'in_progress');
    const status = parsedSteps.every((s) => s.status === 'completed')
      ? 'completed'
      : currentStep
        ? 'in_progress'
        : existing.status;

    return {
      ...existing,
      steps: parsedSteps.sort((a, b) => a.number - b.number),
      currentStepId: currentStep?.id || null,
      status,
      updatedAt: nowIso(),
    };
  }

  private workflowsEqual(a: WorkflowState, b: WorkflowState): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private syncWorkflowFromPlan(taskPath: string, workflow: WorkflowState): WorkflowState {
    const planPath = this.planAbsPath(taskPath, workflow);
    if (!fs.existsSync(planPath)) {
      this.writePlanFile(taskPath, workflow);
      return workflow;
    }

    const markdown = fs.readFileSync(planPath, 'utf8');
    return this.parsePlanMarkdown(markdown, workflow);
  }

  private buildStepPrompt(workflow: WorkflowState, step: WorkflowStep): string {
    const artifactsDir = workflow.artifactsDirRelPath;
    const priorArtifacts = workflow.steps
      .filter((s) => s.number < step.number)
      .flatMap((s) => s.artifacts)
      .filter(Boolean)
      .map((artifact) => `${artifactsDir}/${artifact}`);

    const lines: string[] = [
      `You are executing Step ${step.number}: ${step.title}.`,
      '',
      `Feature: ${workflow.featureDescription}`,
      `Artifacts directory: ${artifactsDir}`,
      '',
      'Instructions:',
      step.instructions,
    ];

    if (priorArtifacts.length > 0) {
      lines.push('', 'Read these existing artifacts first:');
      for (const file of priorArtifacts) {
        lines.push(`- ${file}`);
      }
    }

    if (step.artifacts.length > 0) {
      lines.push('', 'Expected outputs for this step:');
      for (const artifact of step.artifacts) {
        lines.push(`- ${artifactsDir}/${artifact}`);
      }
    }

    lines.push('', 'When complete, summarize what changed and what remains.');
    return lines.join('\n');
  }

  async createWorkflow(args: {
    taskId: string;
    template: WorkflowTemplate;
    featureDescription: string;
    scopeKey?: string;
    taskPathOverride?: string;
  }): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(args.taskId);
    const normalizedScope = normalizeScopeKey(args.scopeKey);
    const taskPath = this.resolveTaskPath(task, args.taskPathOverride);
    const featureDescription = args.featureDescription?.trim() || task.name;
    const createdAt = nowIso();
    const paths = resolveWorkflowPaths(task.id, normalizedScope);

    const steps: WorkflowStep[] = buildTemplateSteps(args.template).map((seed) => ({
      id: buildStepId(seed.number, seed.title),
      number: seed.number,
      title: seed.title,
      instructions: seed.instructions,
      status: 'pending',
      pausePoint: seed.pausePoint,
      conversationId: null,
      artifacts: seed.artifacts,
    }));

    const workflow: WorkflowState = {
      enabled: true,
      scopeKey: normalizedScope,
      type: args.template,
      status: 'planning',
      autoMode: 'manual',
      featureDescription,
      currentStepId: null,
      planRelPath: paths.planRelPath,
      artifactsDirRelPath: paths.scopeDirRelPath,
      steps,
      createdAt,
      updatedAt: createdAt,
    };

    await this.persistTaskWorkflow(task, normalizedScope, workflow);
    this.writePlanFile(taskPath, workflow);
    return workflow;
  }

  async getWorkflow(
    taskId: string,
    scopeKey?: string,
    taskPathOverride?: string
  ): Promise<WorkflowState | null> {
    const task = await this.getTaskOrThrow(taskId);
    const normalizedScope = normalizeScopeKey(scopeKey);
    const taskPath = this.resolveTaskPath(task, taskPathOverride);
    const workflow = this.getWorkflowFromTask(task, normalizedScope);
    if (!workflow) return null;

    const synced = this.syncWorkflowFromPlan(taskPath, workflow);
    if (!this.workflowsEqual(synced, workflow)) {
      await this.persistTaskWorkflow(task, normalizedScope, synced);
      return synced;
    }

    return workflow;
  }

  async setAutoMode(args: {
    taskId: string;
    autoMode: WorkflowAutoMode;
    scopeKey?: string;
    taskPathOverride?: string;
  }): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(args.taskId);
    const normalizedScope = normalizeScopeKey(args.scopeKey);
    const taskPath = this.resolveTaskPath(task, args.taskPathOverride);
    const existing = this.getWorkflowFromTask(task, normalizedScope);
    if (!existing) {
      throw new Error('Workflow is not initialized for this task/scope');
    }

    const workflow = this.syncWorkflowFromPlan(taskPath, existing);
    const next: WorkflowState = {
      ...workflow,
      autoMode: args.autoMode,
      updatedAt: nowIso(),
    };

    await this.persistTaskWorkflow(task, normalizedScope, next);
    this.writePlanFile(taskPath, next);
    return next;
  }

  async startStep(args: {
    taskId: string;
    stepId: string;
    provider?: string;
    scopeKey?: string;
    taskPathOverride?: string;
  }): Promise<{ workflow: WorkflowState; conversationId: string; prompt: string }> {
    const task = await this.getTaskOrThrow(args.taskId);
    const normalizedScope = normalizeScopeKey(args.scopeKey);
    const taskPath = this.resolveTaskPath(task, args.taskPathOverride);
    const existing = this.getWorkflowFromTask(task, normalizedScope);
    if (!existing) {
      throw new Error('Workflow is not initialized for this task/scope');
    }

    const workflow = this.syncWorkflowFromPlan(taskPath, existing);
    const stepIndex = workflow.steps.findIndex((step) => step.id === args.stepId);
    if (stepIndex < 0) {
      throw new Error(`Step not found: ${args.stepId}`);
    }

    const step = workflow.steps[stepIndex];
    const prompt = this.buildStepPrompt(workflow, step);
    const provider = args.provider || task.agentId || 'claude';
    const shouldMarkInProgress = step.status !== 'completed';

    let conversationId = step.conversationId;
    if (!conversationId) {
      const created = await databaseService.createConversation(
        task.id,
        `Step ${step.number}: ${step.title}`,
        provider,
        false
      );
      conversationId = created.id;

      const conversationMetadata = parseJsonObject(created.metadata);
      const stepMetadata: WorkflowStepConversationMetadata = {
        stepId: step.id,
        stepNumber: step.number,
        stepTitle: step.title,
        initialPrompt: prompt,
        promptSent: false,
      };
      conversationMetadata.workflowStep = stepMetadata;

      await databaseService.saveConversation({
        ...created,
        metadata: JSON.stringify(conversationMetadata),
        provider,
      });
    }

    await databaseService.setActiveConversation(task.id, conversationId);

    const steps = workflow.steps.map((candidate) => {
      if (candidate.id === step.id) {
        if (!shouldMarkInProgress) {
          return {
            ...candidate,
            conversationId,
          };
        }
        return {
          ...candidate,
          status: 'in_progress' as const,
          conversationId,
          startedAt: candidate.startedAt || nowIso(),
        };
      }
      if (shouldMarkInProgress && candidate.status === 'in_progress') {
        return { ...candidate, status: 'pending' as const };
      }
      return candidate;
    });

    const next: WorkflowState = {
      ...workflow,
      status: shouldMarkInProgress ? 'in_progress' : workflow.status,
      currentStepId: shouldMarkInProgress ? step.id : workflow.currentStepId,
      steps,
      updatedAt: nowIso(),
    };

    await this.persistTaskWorkflow(task, normalizedScope, next);
    this.writePlanFile(taskPath, next);

    return {
      workflow: next,
      conversationId,
      prompt,
    };
  }

  async completeStep(args: {
    taskId: string;
    stepId: string;
    scopeKey?: string;
    taskPathOverride?: string;
  }): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(args.taskId);
    const normalizedScope = normalizeScopeKey(args.scopeKey);
    const taskPath = this.resolveTaskPath(task, args.taskPathOverride);
    const existing = this.getWorkflowFromTask(task, normalizedScope);
    if (!existing) {
      throw new Error('Workflow is not initialized for this task/scope');
    }

    const workflow = this.syncWorkflowFromPlan(taskPath, existing);
    const step = workflow.steps.find((candidate) => candidate.id === args.stepId);
    if (!step) {
      throw new Error(`Step not found: ${args.stepId}`);
    }

    const steps = workflow.steps.map((candidate) => {
      if (candidate.id !== args.stepId) return candidate;
      return {
        ...candidate,
        status: 'completed' as const,
        completedAt: nowIso(),
      };
    });

    const allComplete = steps.every((candidate) => candidate.status === 'completed');
    const nextStatus: WorkflowState['status'] = allComplete
      ? 'completed'
      : step.pausePoint
        ? 'paused'
        : 'in_progress';

    const next: WorkflowState = {
      ...workflow,
      status: nextStatus,
      currentStepId: null,
      steps,
      updatedAt: nowIso(),
    };

    await this.persistTaskWorkflow(task, normalizedScope, next);
    this.writePlanFile(taskPath, next);
    return next;
  }

  async nextStep(args: {
    taskId: string;
    provider?: string;
    scopeKey?: string;
    taskPathOverride?: string;
  }): Promise<{ workflow: WorkflowState; conversationId: string; prompt: string } | null> {
    const task = await this.getTaskOrThrow(args.taskId);
    const normalizedScope = normalizeScopeKey(args.scopeKey);
    const taskPath = this.resolveTaskPath(task, args.taskPathOverride);
    const existing = this.getWorkflowFromTask(task, normalizedScope);
    if (!existing) {
      throw new Error('Workflow is not initialized for this task/scope');
    }

    const workflow = this.syncWorkflowFromPlan(taskPath, existing);
    if (!this.workflowsEqual(workflow, existing)) {
      await this.persistTaskWorkflow(task, normalizedScope, workflow);
      this.writePlanFile(taskPath, workflow);
    }

    const nextPending = workflow.steps
      .slice()
      .sort((a, b) => a.number - b.number)
      .find((step) => step.status === 'pending');

    if (!nextPending) {
      return null;
    }

    return this.startStep({
      taskId: args.taskId,
      stepId: nextPending.id,
      provider: args.provider,
      scopeKey: normalizedScope,
      taskPathOverride: args.taskPathOverride,
    });
  }

  async reparsePlan(
    taskId: string,
    scopeKey?: string,
    taskPathOverride?: string
  ): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(taskId);
    const normalizedScope = normalizeScopeKey(scopeKey);
    const taskPath = this.resolveTaskPath(task, taskPathOverride);
    const workflow = this.getWorkflowFromTask(task, normalizedScope);
    if (!workflow) {
      throw new Error('Workflow is not initialized for this task/scope');
    }

    const reparsed = this.syncWorkflowFromPlan(taskPath, workflow);
    await this.persistTaskWorkflow(task, normalizedScope, reparsed);
    this.writePlanFile(taskPath, reparsed);
    return reparsed;
  }
}

export const workflowService = new WorkflowService();
