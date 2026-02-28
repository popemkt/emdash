export type WorkflowTemplate = 'spec-and-build' | 'full-sdd';

export type WorkflowStatus = 'planning' | 'in_progress' | 'paused' | 'completed' | 'blocked';

export type WorkflowAutoMode = 'manual' | 'auto';

export type WorkflowStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface WorkflowStep {
  id: string;
  number: number;
  title: string;
  instructions: string;
  status: WorkflowStepStatus;
  pausePoint: boolean;
  conversationId: string | null;
  artifacts: string[];
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowState {
  enabled: true;
  type: WorkflowTemplate;
  status: WorkflowStatus;
  autoMode: WorkflowAutoMode;
  featureDescription: string;
  currentStepId: string | null;
  planRelPath: string;
  artifactsDirRelPath: string;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepConversationMetadata {
  stepId: string;
  stepNumber: number;
  stepTitle: string;
  initialPrompt?: string;
  promptSent?: boolean;
}
