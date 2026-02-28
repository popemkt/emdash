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

const WORKFLOW_DIR_REL = '.emdash/workflow';
const PLAN_REL_PATH = `${WORKFLOW_DIR_REL}/plan.md`;
const CHAT_ID_COMMENT = /^\s*<!--\s*emdash:chat-id=(.*?)\s*-->\s*$/;
const STEP_ID_COMMENT = /^\s*<!--\s*emdash:step-id=(.*?)\s*-->\s*$/;
const PAUSE_COMMENT = /^\s*<!--\s*emdash:pause-point=(true|false)\s*-->\s*$/;

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

function buildTemplateSteps(template: WorkflowTemplate): StepSeed[] {
  if (template === 'spec-and-build') {
    return [
      {
        number: 1,
        title: 'Technical Spec',
        instructions:
          'Analyze the feature and write a technical specification to .emdash/workflow/spec.md. Include architecture, affected files, risks, and rollout notes.',
        pausePoint: true,
        artifacts: ['spec.md'],
      },
      {
        number: 2,
        title: 'Implementation',
        instructions:
          'Implement the feature based on spec.md. Summarize completed work and open items in .emdash/workflow/report.md.',
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
        'Clarify and document requirements in .emdash/workflow/requirements.md. Capture assumptions and questions for user confirmation.',
      pausePoint: true,
      artifacts: ['requirements.md'],
    },
    {
      number: 2,
      title: 'Technical Spec',
      instructions:
        'Produce a technical specification in .emdash/workflow/spec.md using requirements.md as input.',
      pausePoint: false,
      artifacts: ['spec.md'],
    },
    {
      number: 3,
      title: 'Planning',
      instructions:
        'Expand .emdash/workflow/plan.md into concrete implementation steps. Keep each new step coherent and executable in a single focused chat.',
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

export class WorkflowService {
  private getWorkflowFromTask(task: Task): WorkflowState | null {
    const workflow = task.metadata?.workflow;
    if (!workflow || typeof workflow !== 'object') return null;
    if (workflow.enabled !== true) return null;
    if (!Array.isArray(workflow.steps)) return null;
    return workflow as WorkflowState;
  }

  private async getTaskOrThrow(taskId: string): Promise<Task> {
    const task = await databaseService.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private withWorkflowMetadata(task: Task, workflow: WorkflowState): Task {
    return {
      ...task,
      metadata: {
        ...(task.metadata || {}),
        workflow,
      },
    };
  }

  private async persistTaskWorkflow(task: Task, workflow: WorkflowState): Promise<WorkflowState> {
    const nextTask = this.withWorkflowMetadata(task, workflow);
    await databaseService.saveTask(nextTask);
    return workflow;
  }

  private ensureWorkflowDir(taskPath: string): string {
    const abs = path.join(taskPath, WORKFLOW_DIR_REL);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }

  private planAbsPath(taskPath: string): string {
    return path.join(taskPath, PLAN_REL_PATH);
  }

  private renderPlanMarkdown(workflow: WorkflowState): string {
    const lines: string[] = [];
    lines.push('# Workflow Plan');
    lines.push('');
    lines.push(`Feature: ${workflow.featureDescription}`);
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
    lines.push('- Edit step instructions in task metadata/UI, not directly in this file.');
    lines.push('- Chat IDs are persisted in the comment line below each step.');
    lines.push('');

    return lines.join('\n');
  }

  private writePlanFile(taskPath: string, workflow: WorkflowState): void {
    this.ensureWorkflowDir(taskPath);
    fs.writeFileSync(this.planAbsPath(taskPath), this.renderPlanMarkdown(workflow), 'utf8');
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
  }): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(args.taskId);
    const featureDescription = args.featureDescription?.trim() || task.name;
    const createdAt = nowIso();
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
      type: args.template,
      status: 'planning',
      autoMode: 'manual',
      featureDescription,
      currentStepId: null,
      planRelPath: PLAN_REL_PATH,
      artifactsDirRelPath: WORKFLOW_DIR_REL,
      steps,
      createdAt,
      updatedAt: createdAt,
    };

    await this.persistTaskWorkflow(task, workflow);
    this.writePlanFile(task.path, workflow);
    return workflow;
  }

  async getWorkflow(taskId: string): Promise<WorkflowState | null> {
    const task = await this.getTaskOrThrow(taskId);
    return this.getWorkflowFromTask(task);
  }

  async setAutoMode(args: { taskId: string; autoMode: WorkflowAutoMode }): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(args.taskId);
    const workflow = this.getWorkflowFromTask(task);
    if (!workflow) {
      throw new Error('Workflow is not initialized for this task');
    }

    const next: WorkflowState = {
      ...workflow,
      autoMode: args.autoMode,
      updatedAt: nowIso(),
    };

    await this.persistTaskWorkflow(task, next);
    this.writePlanFile(task.path, next);
    return next;
  }

  async startStep(args: {
    taskId: string;
    stepId: string;
    provider?: string;
  }): Promise<{ workflow: WorkflowState; conversationId: string; prompt: string }> {
    const task = await this.getTaskOrThrow(args.taskId);
    const workflow = this.getWorkflowFromTask(task);
    if (!workflow) {
      throw new Error('Workflow is not initialized for this task');
    }

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

    await this.persistTaskWorkflow(task, next);
    this.writePlanFile(task.path, next);

    return {
      workflow: next,
      conversationId,
      prompt,
    };
  }

  async completeStep(args: { taskId: string; stepId: string }): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(args.taskId);
    const workflow = this.getWorkflowFromTask(task);
    if (!workflow) {
      throw new Error('Workflow is not initialized for this task');
    }

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

    await this.persistTaskWorkflow(task, next);
    this.writePlanFile(task.path, next);
    return next;
  }

  async nextStep(args: {
    taskId: string;
    provider?: string;
  }): Promise<{ workflow: WorkflowState; conversationId: string; prompt: string } | null> {
    const task = await this.getTaskOrThrow(args.taskId);
    const workflow = this.getWorkflowFromTask(task);
    if (!workflow) {
      throw new Error('Workflow is not initialized for this task');
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
    });
  }

  async reparsePlan(taskId: string): Promise<WorkflowState> {
    const task = await this.getTaskOrThrow(taskId);
    const workflow = this.getWorkflowFromTask(task);
    if (!workflow) {
      throw new Error('Workflow is not initialized for this task');
    }

    const planPath = this.planAbsPath(task.path);
    if (!fs.existsSync(planPath)) {
      throw new Error(`Plan file not found: ${planPath}`);
    }

    const markdown = fs.readFileSync(planPath, 'utf8');
    const reparsed = this.parsePlanMarkdown(markdown, workflow);
    await this.persistTaskWorkflow(task, reparsed);
    this.writePlanFile(task.path, reparsed);
    return reparsed;
  }
}

export const workflowService = new WorkflowService();
