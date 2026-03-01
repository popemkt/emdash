import type { WorkflowStepStatus, WorkflowTemplate } from '@shared/workflow/types';

export function workflowTemplateLabel(template: WorkflowTemplate): string {
  if (template === 'full-sdd') return 'Full SDD';
  if (template === 'spec-and-build') return 'Spec & Build';
  return 'Simple Prompt';
}

export function workflowStatusDotClass(status: WorkflowStepStatus): string {
  if (status === 'completed') return 'bg-green-500';
  if (status === 'blocked') return 'bg-red-500';
  if (status === 'in_progress') return 'bg-amber-500';
  return 'bg-muted-foreground/50';
}
