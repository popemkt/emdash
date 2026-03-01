import React, { useCallback, useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import ChatInterface from '../ChatInterface';
import ZenflowSidebar from './ZenflowSidebar';
import { useZenflowWorkflow } from '../../hooks/useZenflowWorkflow';
import type { Agent } from '../../types';
import type { Task } from '../../types/app';
import type { PlanStepData } from '@shared/zenflow/types';

interface ZenflowChatLayoutProps {
  task: Task;
  projectName: string;
  projectPath?: string | null;
  projectRemoteConnectionId?: string | null;
  projectRemotePath?: string | null;
  defaultBranch?: string | null;
  initialAgent?: Agent;
  onTaskInterfaceReady?: () => void;
}

/**
 * Wraps ChatInterface with the ZenflowSidebar.
 * Calls useZenflowWorkflow once and shares the data with both components.
 */
const ZenflowChatLayout: React.FC<ZenflowChatLayoutProps> = ({
  task,
  projectName,
  projectPath,
  projectRemoteConnectionId,
  projectRemotePath,
  defaultBranch,
  initialAgent,
  onTaskInterfaceReady,
}) => {
  const zenflow = useZenflowWorkflow(task);
  const [selectedPendingStep, setSelectedPendingStep] = useState<PlanStepData | null>(null);

  // Clear placeholder when a step starts and dispatches switch-to-conversation
  useEffect(() => {
    const handler = () => setSelectedPendingStep(null);
    window.addEventListener('zenflow:switch-to-conversation', handler);
    return () => window.removeEventListener('zenflow:switch-to-conversation', handler);
  }, []);

  const handleStepClick = useCallback((conversationId: string) => {
    // If a step with a conversationId is clicked, clear the placeholder and switch
    setSelectedPendingStep(null);
    window.dispatchEvent(
      new CustomEvent('zenflow:switch-to-conversation', {
        detail: { conversationId },
      })
    );
  }, []);

  const handlePendingStepClick = useCallback((step: PlanStepData) => {
    setSelectedPendingStep(step);
  }, []);

  const handleStartStep = useCallback(
    (stepId: string) => {
      setSelectedPendingStep(null);
      window.electronAPI.zenflowStartStep({ taskId: task.id, stepId });
    },
    [task.id]
  );

  return (
    <div className="flex min-h-0 flex-1">
      {zenflow.planSteps.length > 0 && (
        <ZenflowSidebar
          steps={zenflow.planSteps}
          workflowStatus={zenflow.workflowStatus}
          autoStartSteps={zenflow.autoStartSteps}
          onAutoStartChange={zenflow.setAutoStartSteps}
          onPause={zenflow.pause}
          onResume={zenflow.resume}
          onStartStep={handleStartStep}
          onRetryStep={(stepId) => zenflow.retryStep(stepId)}
          onStepClick={handleStepClick}
          onPendingStepClick={handlePendingStepClick}
          taskId={task.id}
          taskPath={task.path}
        />
      )}
      {selectedPendingStep ? (
        <StepPlaceholder
          step={selectedPendingStep}
          isNextPending={
            selectedPendingStep === zenflow.planSteps.find((s) => s.status === 'pending')
          }
          onStart={() => handleStartStep(`step-${task.id}-${selectedPendingStep.stepNumber}`)}
        />
      ) : (
        <ChatInterface
          task={task}
          projectName={projectName}
          projectPath={projectPath}
          projectRemoteConnectionId={projectRemoteConnectionId}
          projectRemotePath={projectRemotePath}
          defaultBranch={defaultBranch}
          className="min-h-0 flex-1"
          initialAgent={initialAgent}
          onTaskInterfaceReady={onTaskInterfaceReady}
          zenflowData={zenflow}
        />
      )}
    </div>
  );
};

/** Placeholder shown when an unstarted step is selected in the sidebar. */
const StepPlaceholder: React.FC<{
  step: PlanStepData;
  isNextPending: boolean;
  onStart: () => void;
}> = ({ step, isNextPending, onStart }) => (
  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-background p-8 text-center">
    <div className="text-sm uppercase tracking-wider text-muted-foreground/60">
      Step {step.stepNumber}
    </div>
    <h2 className="text-lg font-medium text-foreground">{step.name}</h2>
    <p className="max-w-md text-sm text-muted-foreground">
      {step.type === 'spec' &&
        'This step will analyze the feature request and produce a technical specification.'}
      {step.type === 'requirements' &&
        'This step will gather and document requirements for the feature.'}
      {step.type === 'planning' &&
        'This step will create a detailed implementation plan with sub-tasks.'}
      {step.type === 'implementation' &&
        'This step will implement the feature based on the spec and plan.'}
    </p>
    <div className="text-xs text-muted-foreground/50">
      {step.status === 'pending' ? 'Not started yet' : step.status}
    </div>
    {isNextPending && (
      <button
        onClick={onStart}
        className="mt-2 flex items-center gap-2 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
      >
        <Play className="h-4 w-4" />
        Start Step
      </button>
    )}
  </div>
);

export default ZenflowChatLayout;
