import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Layers3 } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import type { Task } from '../types/app';
import type { Agent } from '../types';
import type { WorkflowState } from '@shared/workflow/types';
import { workflowStatusDotClass, workflowTemplateLabel } from '@/lib/workflowUi';

interface ScopeOption {
  scopeKey: string;
  label: string;
  taskPathOverride?: string;
}

interface Props {
  task: Task;
  activeTaskAgent: Agent | null;
  onCollapse: () => void;
}

function normalizeWorkflowScopeKey(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return 'default';
  const normalized = value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

const TaskWorkspaceSidebar: React.FC<Props> = ({ task, activeTaskAgent, onCollapse }) => {
  const [workflowByScope, setWorkflowByScope] = useState<Record<string, WorkflowState | null>>({});
  const [loadingByScope, setLoadingByScope] = useState<Record<string, boolean>>({});
  const multi = task.metadata?.multiAgent;

  const scopeOptions = useMemo<ScopeOption[]>(() => {
    if (multi?.enabled && Array.isArray(multi.variants) && multi.variants.length > 0) {
      return multi.variants.map((variant, index) => ({
        scopeKey: normalizeWorkflowScopeKey(variant.worktreeId || variant.id || variant.agent),
        label: `${variant.agent}${multi.variants.length > 1 ? ` ${index + 1}` : ''}`,
        taskPathOverride: variant.path,
      }));
    }

    const providerScope = normalizeWorkflowScopeKey(activeTaskAgent || task.agentId || 'default');
    return [{ scopeKey: providerScope, label: activeTaskAgent || task.agentId || 'default' }];
  }, [multi, activeTaskAgent, task.agentId]);

  const [activeScopeKey, setActiveScopeKey] = useState<string>(
    () => scopeOptions[0]?.scopeKey || 'default'
  );

  useEffect(() => {
    setActiveScopeKey(scopeOptions[0]?.scopeKey || 'default');
    setWorkflowByScope({});
    setLoadingByScope({});
  }, [task.id, scopeOptions]);

  const activeScope = useMemo(
    () =>
      scopeOptions.find((scope) => scope.scopeKey === activeScopeKey) || scopeOptions[0] || null,
    [scopeOptions, activeScopeKey]
  );

  const hasSnapshot = activeScope
    ? Object.prototype.hasOwnProperty.call(workflowByScope, activeScope.scopeKey)
    : false;
  const workflow =
    activeScope && hasSnapshot ? workflowByScope[activeScope.scopeKey] || null : null;
  const isLoading = activeScope ? Boolean(loadingByScope[activeScope.scopeKey]) : false;
  const showLoadingPlaceholder = isLoading && !hasSnapshot;

  const loadWorkflow = useCallback(async () => {
    if (!activeScope) return;
    const scopeKey = activeScope.scopeKey;
    setLoadingByScope((prev) => ({
      ...prev,
      [scopeKey]: true,
    }));

    try {
      const result = await window.electronAPI.workflowGet({
        taskId: task.id,
        scopeKey,
        taskPathOverride: activeScope.taskPathOverride,
      });
      setWorkflowByScope((prev) => ({
        ...prev,
        [scopeKey]: result.success ? result.workflow || null : null,
      }));
    } catch {
      setWorkflowByScope((prev) => ({
        ...prev,
        [scopeKey]: null,
      }));
    } finally {
      setLoadingByScope((prev) => ({
        ...prev,
        [scopeKey]: false,
      }));
    }
  }, [activeScope, task.id]);

  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadWorkflow();
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [loadWorkflow]);

  return (
    <aside className="flex h-full min-w-0 flex-col border-r border-border/70 bg-muted/20">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Layers3 className="h-3.5 w-3.5" />
          Task Workspace
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onCollapse}
          title="Collapse sidebar"
          aria-label="Collapse task workspace sidebar"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-2">
          <div className="text-sm font-semibold text-foreground">{task.name}</div>
          <div className="text-xs text-muted-foreground">{task.branch}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{task.status}</Badge>
            {workflow ? (
              <Badge variant="outline">{workflowTemplateLabel(workflow.type)}</Badge>
            ) : null}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-foreground">Scopes</div>
          <div className="flex flex-wrap gap-1.5">
            {scopeOptions.map((scope) => (
              <Button
                key={scope.scopeKey}
                type="button"
                size="sm"
                variant={scope.scopeKey === activeScope?.scopeKey ? 'secondary' : 'outline'}
                className="h-6 px-2 text-xs"
                onClick={() => setActiveScopeKey(scope.scopeKey)}
              >
                {scope.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-foreground">Steps</div>
          {showLoadingPlaceholder ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size="sm" />
              Loading workflow...
            </div>
          ) : workflow ? (
            <div className="space-y-1.5">
              {workflow.steps
                .slice()
                .sort((a, b) => a.number - b.number)
                .map((step) => {
                  const isCurrent = workflow.currentStepId === step.id;
                  return (
                    <div
                      key={step.id}
                      className={`rounded border border-border/60 bg-background px-2 py-1.5 text-xs ${
                        isCurrent ? 'border-foreground/30' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${workflowStatusDotClass(step.status)}`}
                        />
                        <span className="truncate font-medium text-foreground">
                          {step.number}. {step.title}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {step.status.replace('_', ' ')}
                        {step.pausePoint ? ' · pause' : ''}
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="rounded border border-dashed border-border/70 bg-background/40 px-2 py-2 text-xs text-muted-foreground">
              No workflow initialized for this scope yet.
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default TaskWorkspaceSidebar;
