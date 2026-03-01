import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Task } from '../types/chat';
import { type Agent } from '../types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import OpenInMenu from './titlebar/OpenInMenu';
import { TerminalPane } from './TerminalPane';
import { agentMeta } from '@/providers/meta';
import { agentAssets } from '@/providers/assets';
import AgentLogo from './AgentLogo';
import { useTheme } from '@/hooks/useTheme';
import { useToast } from '@/hooks/use-toast';
import { classifyActivity } from '@/lib/activityClassifier';
import { activityStore } from '@/lib/activityStore';
import { Spinner } from './ui/spinner';
import { BUSY_HOLD_MS, CLEAR_BUSY_MS, INJECT_ENTER_DELAY_MS } from '@/lib/activityConstants';
import { Check, Pause, Play } from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { useAutoScrollOnTaskSwitch } from '@/hooks/useAutoScrollOnTaskSwitch';
import { getTaskEnvVars } from '@shared/task/envVars';
import { makePtyId } from '@shared/ptyId';
import type { ProviderId } from '@shared/providers/registry';
import type { WorkflowState, WorkflowStep, WorkflowTemplate } from '@shared/workflow/types';
import TaskMessageComposer from './TaskMessageComposer';
import { workflowStatusDotClass, workflowTemplateLabel } from '@/lib/workflowUi';

interface Props {
  task: Task;
  projectName: string;
  projectId: string;
  projectPath?: string | null;
  projectRemoteConnectionId?: string | null;
  projectRemotePath?: string | null;
  defaultBranch?: string | null;
  onTaskInterfaceReady?: () => void;
}

type Variant = {
  id: string;
  agent: Agent;
  name: string;
  branch: string;
  path: string;
  worktreeId: string;
};

function normalizeWorkflowScopeKey(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return 'default';
  const normalized = value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function getVariantWorkflowScope(variant: Variant): string {
  return normalizeWorkflowScopeKey(variant.worktreeId || variant.id || variant.agent);
}

function getVariantMainPtyId(variant: Variant): string {
  return makePtyId(variant.agent as ProviderId, 'main', variant.worktreeId);
}

function getVariantChatPtyId(variant: Variant, conversationId: string): string {
  return makePtyId(variant.agent as ProviderId, 'chat', conversationId);
}

const MultiAgentTask: React.FC<Props> = ({
  task,
  projectPath,
  projectRemoteConnectionId,
  projectRemotePath: _projectRemotePath,
  defaultBranch,
  onTaskInterfaceReady,
}) => {
  const { effectiveTheme } = useTheme();
  const { toast } = useToast();
  const [prompt, setPrompt] = useState('');
  const [promptTarget, setPromptTarget] = useState<'active' | 'all'>('all');
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [variantBusy, setVariantBusy] = useState<Record<string, boolean>>({});
  const [workflowByScope, setWorkflowByScope] = useState<Record<string, WorkflowState | null>>({});
  const [workflowLoadingByScope, setWorkflowLoadingByScope] = useState<Record<string, boolean>>({});
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowTemplate, setWorkflowTemplate] = useState<WorkflowTemplate>('simple-prompt');
  const [variantSessionConversationIds, setVariantSessionConversationIds] = useState<
    Record<string, string | null>
  >({});
  const multi = task.metadata?.multiAgent;
  const variants = (multi?.variants || []) as Variant[];
  const activeVariant = variants[activeTabIndex] || null;
  const activeWorkflowScope = activeVariant ? getVariantWorkflowScope(activeVariant) : null;
  const hasActiveWorkflowSnapshot = activeWorkflowScope
    ? Object.prototype.hasOwnProperty.call(workflowByScope, activeWorkflowScope)
    : false;
  const activeWorkflow =
    activeWorkflowScope && hasActiveWorkflowSnapshot ? workflowByScope[activeWorkflowScope] : null;
  const getVariantTerminalId = useCallback(
    (variant: Variant) => {
      const conversationId = variantSessionConversationIds[variant.worktreeId];
      if (conversationId) {
        return getVariantChatPtyId(variant, conversationId);
      }
      return getVariantMainPtyId(variant);
    },
    [variantSessionConversationIds]
  );

  const variantEnvs = useMemo(() => {
    if (!projectPath) return new Map<string, Record<string, string>>();
    const envMap = new Map<string, Record<string, string>>();
    for (const variant of variants) {
      const key = variant.worktreeId || variant.path;
      envMap.set(
        key,
        getTaskEnvVars({
          taskId: task.id,
          taskName: variant.name || task.name,
          taskPath: variant.path,
          projectPath,
          defaultBranch: defaultBranch || undefined,
          portSeed: key,
        })
      );
    }
    return envMap;
  }, [variants, task.id, task.name, projectPath, defaultBranch]);

  // Auto-scroll to bottom when this task becomes active
  const { scrollToBottom } = useAutoScrollOnTaskSwitch(true, task.id);

  const readySignaledTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onTaskInterfaceReady) return;
    if (variants.length === 0) return;
    if (readySignaledTaskIdRef.current === task.id) return;
    readySignaledTaskIdRef.current = task.id;
    onTaskInterfaceReady();
  }, [task.id, variants.length, onTaskInterfaceReady]);

  useEffect(() => {
    setVariantSessionConversationIds((prev) => {
      const next: Record<string, string | null> = {};
      for (const variant of variants) {
        next[variant.worktreeId] = prev[variant.worktreeId] ?? null;
      }
      return next;
    });
    setWorkflowByScope((prev) => {
      const next: Record<string, WorkflowState | null> = {};
      for (const variant of variants) {
        const scopeKey = getVariantWorkflowScope(variant);
        if (Object.prototype.hasOwnProperty.call(prev, scopeKey)) {
          next[scopeKey] = prev[scopeKey] ?? null;
        }
      }
      return next;
    });
    setWorkflowLoadingByScope((prev) => {
      const next: Record<string, boolean> = {};
      for (const variant of variants) {
        const scopeKey = getVariantWorkflowScope(variant);
        next[scopeKey] = prev[scopeKey] ?? false;
      }
      return next;
    });
  }, [variants]);

  // Helper to generate display label with instance number if needed
  const getVariantDisplayLabel = (variant: Variant): string => {
    const meta = agentMeta[variant.agent];
    const baseName = meta?.label || variant.agent;

    // Count how many variants use this agent
    const agentVariants = variants.filter((v) => v.agent === variant.agent);

    // If only one instance of this agent, just show base name
    if (agentVariants.length === 1) {
      return baseName;
    }

    // Multiple instances: extract instance number from variant name
    // variant.name format: "task-agent-1", "task-agent-2", etc.
    const match = variant.name.match(/-(\d+)$/);
    const instanceNum = match ? match[1] : String(agentVariants.indexOf(variant) + 1);

    return `${baseName} #${instanceNum}`;
  };

  const loadActiveWorkflow = useCallback(async () => {
    if (!activeVariant || !activeWorkflowScope) {
      return;
    }
    const scopeKey = activeWorkflowScope;
    const taskPathOverride = activeVariant.path;
    setWorkflowLoadingByScope((prev) => ({
      ...prev,
      [scopeKey]: true,
    }));

    try {
      const result = await window.electronAPI.workflowGet({
        taskId: task.id,
        scopeKey,
        taskPathOverride,
      });
      if (!result.success) {
        setWorkflowByScope((prev) => ({
          ...prev,
          [scopeKey]: null,
        }));
        return;
      }
      setWorkflowByScope((prev) => ({
        ...prev,
        [scopeKey]: (result.workflow as WorkflowState | null | undefined) || null,
      }));
    } catch {
      setWorkflowByScope((prev) => ({
        ...prev,
        [scopeKey]: null,
      }));
    } finally {
      setWorkflowLoadingByScope((prev) => ({
        ...prev,
        [scopeKey]: false,
      }));
    }
  }, [task.id, activeVariant, activeWorkflowScope]);

  useEffect(() => {
    void loadActiveWorkflow();
  }, [loadActiveWorkflow]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadActiveWorkflow();
    }, 2500);
    return () => window.clearInterval(intervalId);
  }, [loadActiveWorkflow]);

  const initializeWorkflowForVariant = useCallback(
    async (variant: Variant, template: WorkflowTemplate) => {
      const scopeKey = getVariantWorkflowScope(variant);
      const result = await window.electronAPI.workflowCreate({
        taskId: task.id,
        template,
        featureDescription:
          (task.metadata?.initialPrompt as string | undefined)?.trim() || task.name,
        scopeKey,
        taskPathOverride: variant.path,
      });
      const createdWorkflow = result.workflow;
      if (!result.success || !createdWorkflow) {
        throw new Error(result.error || 'Failed to initialize workflow');
      }
      setVariantSessionConversationIds((prev) => ({
        ...prev,
        [variant.worktreeId]: null,
      }));
      setWorkflowByScope((prev) => ({
        ...prev,
        [scopeKey]: createdWorkflow,
      }));
      setWorkflowLoadingByScope((prev) => ({
        ...prev,
        [scopeKey]: false,
      }));
    },
    [task.id, task.name, task.metadata?.initialPrompt]
  );

  const handleInitWorkflowForActive = useCallback(async () => {
    if (!activeVariant) return;
    setWorkflowBusy(true);
    try {
      await initializeWorkflowForVariant(activeVariant, workflowTemplate);
    } catch (error) {
      toast({
        title: 'Workflow Error',
        description: error instanceof Error ? error.message : 'Failed to initialize workflow',
        variant: 'destructive',
      });
    } finally {
      setWorkflowBusy(false);
    }
  }, [activeVariant, initializeWorkflowForVariant, workflowTemplate, toast]);

  const handleInitWorkflowForAll = useCallback(async () => {
    if (variants.length === 0) return;
    setWorkflowBusy(true);
    try {
      const orderedVariants = activeVariant
        ? [
            activeVariant,
            ...variants.filter((variant) => variant.worktreeId !== activeVariant.worktreeId),
          ]
        : variants;
      const results = await Promise.allSettled(
        orderedVariants.map((variant) => initializeWorkflowForVariant(variant, workflowTemplate))
      );
      const failed = results.filter(
        (result) => result.status === 'rejected'
      ) as PromiseRejectedResult[];
      if (failed.length > 0) {
        throw new Error(failed[0]?.reason?.message || 'Failed to initialize one or more workflows');
      }
      await loadActiveWorkflow();
    } catch (error) {
      toast({
        title: 'Workflow Error',
        description: error instanceof Error ? error.message : 'Failed to initialize workflows',
        variant: 'destructive',
      });
    } finally {
      setWorkflowBusy(false);
    }
  }, [
    variants,
    activeVariant,
    initializeWorkflowForVariant,
    workflowTemplate,
    loadActiveWorkflow,
    toast,
  ]);

  const handleStartWorkflowStep = useCallback(
    async (stepId: string) => {
      if (!activeVariant || !activeWorkflowScope) return;
      setWorkflowBusy(true);
      try {
        const result = await window.electronAPI.workflowStartStep({
          taskId: task.id,
          stepId,
          provider: activeVariant.agent,
          scopeKey: activeWorkflowScope,
          taskPathOverride: activeVariant.path,
        });
        const startedWorkflow = result.workflow;
        if (!result.success || !startedWorkflow) {
          throw new Error(result.error || 'Failed to start step');
        }
        setWorkflowByScope((prev) => ({
          ...prev,
          [activeWorkflowScope]: startedWorkflow,
        }));
        if (result.conversationId) {
          setVariantSessionConversationIds((prev) => ({
            ...prev,
            [activeVariant.worktreeId]: result.conversationId || null,
          }));
          if (result.prompt) {
            const ptyId = getVariantChatPtyId(activeVariant, result.conversationId);
            void injectPrompt(ptyId, activeVariant.agent, result.prompt);
          }
        }
      } catch (error) {
        toast({
          title: 'Workflow Error',
          description: error instanceof Error ? error.message : 'Failed to start step',
          variant: 'destructive',
        });
      } finally {
        setWorkflowBusy(false);
      }
    },
    [task.id, activeVariant, activeWorkflowScope, toast]
  );

  const handleCompleteWorkflowStep = useCallback(
    async (step: WorkflowStep) => {
      if (!activeVariant || !activeWorkflowScope) return;
      setWorkflowBusy(true);
      try {
        const result = await window.electronAPI.workflowCompleteStep({
          taskId: task.id,
          stepId: step.id,
          scopeKey: activeWorkflowScope,
          taskPathOverride: activeVariant.path,
        });
        if (!result.success || !result.workflow) {
          throw new Error(result.error || 'Failed to complete step');
        }

        let nextWorkflow = result.workflow;
        if (result.workflow.autoMode === 'auto' && !step.pausePoint) {
          const next = await window.electronAPI.workflowNextStep({
            taskId: task.id,
            provider: activeVariant.agent,
            scopeKey: activeWorkflowScope,
            taskPathOverride: activeVariant.path,
          });
          if (next.success && next.result) {
            nextWorkflow = next.result.workflow;
          }
        }

        setWorkflowByScope((prev) => ({
          ...prev,
          [activeWorkflowScope]: nextWorkflow,
        }));
      } catch (error) {
        toast({
          title: 'Workflow Error',
          description: error instanceof Error ? error.message : 'Failed to complete step',
          variant: 'destructive',
        });
      } finally {
        setWorkflowBusy(false);
      }
    },
    [task.id, activeVariant, activeWorkflowScope, toast]
  );

  const handleNextWorkflowStep = useCallback(async () => {
    if (!activeVariant || !activeWorkflowScope) return;
    setWorkflowBusy(true);
    try {
      const result = await window.electronAPI.workflowNextStep({
        taskId: task.id,
        provider: activeVariant.agent,
        scopeKey: activeWorkflowScope,
        taskPathOverride: activeVariant.path,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to start next step');
      }
      const nextStepResult = result.result;
      if (nextStepResult) {
        setWorkflowByScope((prev) => ({
          ...prev,
          [activeWorkflowScope]: nextStepResult.workflow,
        }));
      }
    } catch (error) {
      toast({
        title: 'Workflow Error',
        description: error instanceof Error ? error.message : 'Failed to start next step',
        variant: 'destructive',
      });
    } finally {
      setWorkflowBusy(false);
    }
  }, [task.id, activeVariant, activeWorkflowScope, toast]);

  const handleToggleWorkflowAuto = useCallback(async () => {
    if (!activeWorkflow || !activeVariant || !activeWorkflowScope) return;
    setWorkflowBusy(true);
    try {
      const nextMode = activeWorkflow.autoMode === 'auto' ? 'manual' : 'auto';
      const result = await window.electronAPI.workflowSetAutoMode({
        taskId: task.id,
        autoMode: nextMode,
        scopeKey: activeWorkflowScope,
        taskPathOverride: activeVariant.path,
      });
      const updatedWorkflow = result.workflow;
      if (!result.success || !updatedWorkflow) {
        throw new Error(result.error || 'Failed to update workflow mode');
      }
      setWorkflowByScope((prev) => ({
        ...prev,
        [activeWorkflowScope]: updatedWorkflow,
      }));
    } catch (error) {
      toast({
        title: 'Workflow Error',
        description: error instanceof Error ? error.message : 'Failed to update workflow mode',
        variant: 'destructive',
      });
    } finally {
      setWorkflowBusy(false);
    }
  }, [activeWorkflow, task.id, activeVariant, activeWorkflowScope, toast]);

  // Build initial issue context (feature parity with single-agent ChatInterface)
  const initialInjection: string | null = useMemo(() => {
    const md: any = task.metadata || null;
    if (!md) return null;
    const p = (md.initialPrompt || '').trim();
    if (p) return p;
    // Linear
    const issue = md.linearIssue;
    if (issue) {
      const parts: string[] = [];
      const line1 = `Linked Linear issue: ${issue.identifier}${issue.title ? ` — ${issue.title}` : ''}`;
      parts.push(line1);
      const details: string[] = [];
      if (issue.state?.name) details.push(`State: ${issue.state.name}`);
      if (issue.assignee?.displayName || issue.assignee?.name)
        details.push(`Assignee: ${issue.assignee?.displayName || issue.assignee?.name}`);
      if (issue.team?.key) details.push(`Team: ${issue.team.key}`);
      if (issue.project?.name) details.push(`Project: ${issue.project.name}`);
      if (details.length) parts.push(`Details: ${details.join(' • ')}`);
      if (issue.url) parts.push(`URL: ${issue.url}`);
      const desc = (issue as any)?.description;
      if (typeof desc === 'string' && desc.trim()) {
        const trimmed = desc.trim();
        const max = 1500;
        const body = trimmed.length > max ? trimmed.slice(0, max) + '\n…' : trimmed;
        parts.push('', 'Issue Description:', body);
      }
      return parts.join('\n');
    }
    // GitHub
    const gh = (md as any)?.githubIssue as
      | {
          number: number;
          title?: string;
          url?: string;
          state?: string;
          assignees?: any[];
          labels?: any[];
          body?: string;
        }
      | undefined;
    if (gh) {
      const parts: string[] = [];
      const line1 = `Linked GitHub issue: #${gh.number}${gh.title ? ` — ${gh.title}` : ''}`;
      parts.push(line1);
      const details: string[] = [];
      if (gh.state) details.push(`State: ${gh.state}`);
      try {
        const as = Array.isArray(gh.assignees)
          ? gh.assignees
              .map((a: any) => a?.name || a?.login)
              .filter(Boolean)
              .join(', ')
          : '';
        if (as) details.push(`Assignees: ${as}`);
      } catch {}
      try {
        const ls = Array.isArray(gh.labels)
          ? gh.labels
              .map((l: any) => l?.name)
              .filter(Boolean)
              .join(', ')
          : '';
        if (ls) details.push(`Labels: ${ls}`);
      } catch {}
      if (details.length) parts.push(`Details: ${details.join(' • ')}`);
      if (gh.url) parts.push(`URL: ${gh.url}`);
      const body = typeof gh.body === 'string' ? gh.body.trim() : '';
      if (body) {
        const max = 1500;
        const clipped = body.length > max ? body.slice(0, max) + '\n…' : body;
        parts.push('', 'Issue Description:', clipped);
      }
      return parts.join('\n');
    }
    // Jira
    const j = md?.jiraIssue as any;
    if (j) {
      const lines: string[] = [];
      const l1 = `Linked Jira issue: ${j.key}${j.summary ? ` — ${j.summary}` : ''}`;
      lines.push(l1);
      const details: string[] = [];
      if (j.status?.name) details.push(`Status: ${j.status.name}`);
      if (j.assignee?.displayName || j.assignee?.name)
        details.push(`Assignee: ${j.assignee?.displayName || j.assignee?.name}`);
      if (j.project?.key) details.push(`Project: ${j.project.key}`);
      if (details.length) lines.push(`Details: ${details.join(' • ')}`);
      if (j.url) lines.push(`URL: ${j.url}`);
      return lines.join('\n');
    }
    return null;
  }, [task.metadata]);

  async function injectPrompt(ptyId: string, agent: Agent, text: string) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    let sent = false;
    let silenceTimer: any = null;
    const send = () => {
      if (sent) return;
      sent = true;
      try {
        const pty = (window as any).electronAPI?.ptyInput;
        if (!pty) return;
        // Send text + line endings first so the TUI displays the input,
        // then send a bare \r after a short delay to submit.  Sending
        // Enter separately prevents TUI "paste-detection" from swallowing it.
        pty({ id: ptyId, data: trimmed + '\r\n' });
        setTimeout(() => {
          pty({ id: ptyId, data: '\r' });
        }, INJECT_ENTER_DELAY_MS);
      } catch {}
    };
    const offData = (window as any).electronAPI?.onPtyData?.(ptyId, (chunk: string) => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (!sent) send();
      }, 1000);
      try {
        const signal = classifyActivity(agent, chunk);
        if (signal === 'idle' && !sent) {
          setTimeout(send, 200);
        }
      } catch {}
    });
    const offStarted = (window as any).electronAPI?.onPtyStarted?.((info: { id: string }) => {
      if (info?.id === ptyId) {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          if (!sent) send();
        }, 1500);
      }
    });
    // Fallback in case no events arrive
    // Try once shortly in case PTY is already interactive
    const eager = setTimeout(() => {
      if (!sent) send();
    }, 300);

    const hard = setTimeout(() => {
      if (!sent) send();
    }, 5000);
    // Give the injector a brief window; cleanup shortly after send
    setTimeout(() => {
      clearTimeout(eager);
      clearTimeout(hard);
      if (silenceTimer) clearTimeout(silenceTimer);
      offData?.();
      offStarted?.();
    }, 6000);
  }

  const handleSendPrompt = async () => {
    const msg = prompt.trim();
    if (!msg) return;
    const targets = promptTarget === 'active' && activeVariant ? [activeVariant] : variants;
    const tasks: Promise<unknown>[] = targets.map((variant) =>
      injectPrompt(getVariantTerminalId(variant), variant.agent, msg)
    );
    await Promise.all(tasks);
    setPrompt('');
  };

  // Track per-variant activity so we can render a spinner on the tabs
  useEffect(() => {
    if (!variants.length) {
      setVariantBusy({});
      return;
    }

    // Keep busy state only for currently mounted variants
    setVariantBusy((prev) => {
      const next: Record<string, boolean> = {};
      variants.forEach((v) => {
        next[v.worktreeId] = prev[v.worktreeId] ?? false;
      });
      return next;
    });

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const busySince = new Map<string, number>();
    const busyState = new Map<string, boolean>();

    const publish = (variantId: string, busy: boolean) => {
      busyState.set(variantId, busy);
      setVariantBusy((prev) => {
        if (prev[variantId] === busy) return prev;
        return { ...prev, [variantId]: busy };
      });
    };

    const clearTimer = (variantId: string) => {
      const t = timers.get(variantId);
      if (t) clearTimeout(t);
      timers.delete(variantId);
    };

    const setBusy = (variantId: string, busy: boolean) => {
      const current = busyState.get(variantId) || false;
      if (busy) {
        clearTimer(variantId);
        busySince.set(variantId, Date.now());
        if (!current) publish(variantId, true);
        return;
      }

      const started = busySince.get(variantId) || 0;
      const elapsed = started ? Date.now() - started : BUSY_HOLD_MS;
      const remaining = elapsed < BUSY_HOLD_MS ? BUSY_HOLD_MS - elapsed : 0;

      const clearNow = () => {
        clearTimer(variantId);
        busySince.delete(variantId);
        if (busyState.get(variantId) !== false) publish(variantId, false);
      };

      if (remaining > 0) {
        clearTimer(variantId);
        timers.set(variantId, setTimeout(clearNow, remaining));
      } else {
        clearNow();
      }
    };

    const armNeutral = (variantId: string) => {
      if (!busyState.get(variantId)) return;
      clearTimer(variantId);
      timers.set(
        variantId,
        setTimeout(() => setBusy(variantId, false), CLEAR_BUSY_MS)
      );
    };

    const cleanups: Array<() => void> = [];

    variants.forEach((variant) => {
      const variantId = variant.worktreeId;
      const ptyId = getVariantTerminalId(variant);
      busyState.set(variantId, false);

      const offData = (window as any).electronAPI?.onPtyData?.(ptyId, (chunk: string) => {
        try {
          const signal = classifyActivity(variant.agent, chunk || '');
          if (signal === 'busy') setBusy(variantId, true);
          else if (signal === 'idle') setBusy(variantId, false);
          else armNeutral(variantId);
        } catch {
          // ignore classification failures
        }
      });
      if (offData) cleanups.push(offData);

      const offExit = (window as any).electronAPI?.onPtyExit?.(ptyId, () => {
        setBusy(variantId, false);
      });
      if (offExit) cleanups.push(offExit);
    });

    return () => {
      cleanups.forEach((off) => {
        try {
          off?.();
        } catch {}
      });
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      busySince.clear();
      busyState.clear();
    };
  }, [variants, getVariantTerminalId]);

  // Prefill the top input with the prepared issue context once
  const prefillOnceRef = useRef(false);
  useEffect(() => {
    if (prefillOnceRef.current) return;
    const text = (initialInjection || '').trim();
    if (text && !prompt) {
      setPrompt(text);
    }
    prefillOnceRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInjection]);

  // Sync variant busy state to activityStore for sidebar indicator
  useEffect(() => {
    const anyBusy = Object.values(variantBusy).some(Boolean);
    activityStore.setTaskBusy(task.id, anyBusy);
  }, [variantBusy, task.id]);

  // Ref to the active terminal
  const activeTerminalRef = useRef<{ focus: () => void }>(null);

  // Auto-scroll and focus when task or active tab changes
  useEffect(() => {
    if (variants.length > 0 && activeTabIndex >= 0 && activeTabIndex < variants.length) {
      // Small delay to ensure the tab content is rendered
      const timeout = setTimeout(() => {
        scrollToBottom({ onlyIfNearTop: true });
        // Focus the active terminal when switching tabs
        activeTerminalRef.current?.focus();
      }, 150);

      return () => clearTimeout(timeout);
    }
  }, [task.id, activeTabIndex, variants.length, scrollToBottom]);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleWindowFocus = () => {
      timer = setTimeout(() => {
        timer = null;
        if (!mounted) return;
        activeTerminalRef.current?.focus();
      }, 0);
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      mounted = false;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, []);

  // Switch active agent tab via global shortcuts (Cmd+Shift+J/K)
  useEffect(() => {
    const handleAgentSwitch = (event: Event) => {
      const customEvent = event as CustomEvent<{ direction: 'next' | 'prev' }>;
      if (variants.length <= 1) return;
      const direction = customEvent.detail?.direction;
      if (!direction) return;

      setActiveTabIndex((current) => {
        if (variants.length <= 1) return current;
        if (direction === 'prev') {
          return current <= 0 ? variants.length - 1 : current - 1;
        }
        return (current + 1) % variants.length;
      });
    };

    window.addEventListener('emdash:switch-agent', handleAgentSwitch);
    return () => {
      window.removeEventListener('emdash:switch-agent', handleAgentSwitch);
    };
  }, [variants.length]);

  if (!multi?.enabled) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Multi-agent config missing for this task.
      </div>
    );
  }

  if (variants.length === 0) {
    return <div className="h-full" />;
  }

  return (
    <div className="relative flex h-full flex-col">
      {variants.map((v, idx) => {
        const isDark = effectiveTheme === 'dark' || effectiveTheme === 'dark-black';
        const isActive = idx === activeTabIndex;
        const variantScopeKey = getVariantWorkflowScope(v);
        const hasVariantWorkflowSnapshot = Object.prototype.hasOwnProperty.call(
          workflowByScope,
          variantScopeKey
        );
        const workflowForVariant =
          isActive && hasVariantWorkflowSnapshot ? workflowByScope[variantScopeKey] : null;
        const variantWorkflowLoading = isActive
          ? Boolean(workflowLoadingByScope[variantScopeKey])
          : false;
        const showWorkflowLoadingPlaceholder =
          isActive && variantWorkflowLoading && !hasVariantWorkflowSnapshot;
        const selectedSessionConversationId = variantSessionConversationIds[v.worktreeId] || null;
        const stepSessionOptions =
          isActive && workflowForVariant
            ? workflowForVariant.steps
                .filter((step) => Boolean(step.conversationId))
                .sort((a, b) => a.number - b.number)
                .map((step) => ({
                  stepId: step.id,
                  number: step.number,
                  title: step.title,
                  conversationId: step.conversationId as string,
                }))
            : [];
        return (
          <div
            key={v.worktreeId}
            className={`flex-1 overflow-hidden ${isActive ? '' : 'invisible absolute inset-0'}`}
          >
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-end gap-2 px-3 py-1.5">
                <OpenInMenu
                  path={v.path}
                  isRemote={!!projectRemoteConnectionId}
                  sshConnectionId={projectRemoteConnectionId}
                  isActive={isActive}
                />
              </div>
              <div className="px-6 pt-2">
                <div className="mx-auto min-h-[132px] max-w-4xl rounded-md border border-border/70 bg-muted/30 p-2">
                  {showWorkflowLoadingPlaceholder ? (
                    <div className="flex min-h-[116px] items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Spinner size="sm" />
                      Loading workflow...
                    </div>
                  ) : isActive && workflowForVariant ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-foreground">Workflow:</span>
                        <Badge variant="outline">Scope: {getVariantDisplayLabel(v)}</Badge>
                        <Badge variant="outline">
                          {workflowTemplateLabel(workflowForVariant.type)}
                        </Badge>
                        <Badge variant="secondary">
                          {workflowForVariant.status.replace('_', ' ')}
                        </Badge>
                        <Badge variant="outline">{workflowForVariant.steps.length} steps</Badge>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={workflowBusy}
                          onClick={() => void handleToggleWorkflowAuto()}
                          className="h-7 px-2.5 text-xs"
                        >
                          {workflowForVariant.autoMode === 'auto' ? (
                            <>
                              <Pause className="mr-1.5 h-3.5 w-3.5" />
                              Auto: On
                            </>
                          ) : (
                            <>
                              <Play className="mr-1.5 h-3.5 w-3.5" />
                              Auto: Off
                            </>
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={workflowBusy}
                          onClick={() => void handleNextWorkflowStep()}
                          className="h-7 px-2.5 text-xs"
                        >
                          Next Step
                        </Button>
                        <Select
                          value={workflowTemplate}
                          onValueChange={(value) => setWorkflowTemplate(value as WorkflowTemplate)}
                        >
                          <SelectTrigger className="h-7 w-[160px] bg-background text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent side="top" className="z-[120]">
                            <SelectItem value="simple-prompt">Simple Prompt</SelectItem>
                            <SelectItem value="spec-and-build">Spec & Build</SelectItem>
                            <SelectItem value="full-sdd">Full SDD</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={workflowBusy}
                          onClick={() => void handleInitWorkflowForActive()}
                          className="h-7 px-2.5 text-xs"
                        >
                          Re-init Active
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={workflowBusy}
                          onClick={() => void handleInitWorkflowForAll()}
                          className="h-7 px-2.5 text-xs"
                        >
                          Init All Agents
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Sessions:</span>
                        <Button
                          type="button"
                          size="sm"
                          variant={selectedSessionConversationId ? 'outline' : 'secondary'}
                          disabled={workflowBusy}
                          onClick={() =>
                            setVariantSessionConversationIds((prev) => ({
                              ...prev,
                              [v.worktreeId]: null,
                            }))
                          }
                          className="h-6 px-2 text-xs"
                        >
                          Main
                        </Button>
                        {stepSessionOptions.map((session) => (
                          <Button
                            key={session.stepId}
                            type="button"
                            size="sm"
                            variant={
                              selectedSessionConversationId === session.conversationId
                                ? 'secondary'
                                : 'outline'
                            }
                            disabled={workflowBusy}
                            onClick={() =>
                              setVariantSessionConversationIds((prev) => ({
                                ...prev,
                                [v.worktreeId]: session.conversationId,
                              }))
                            }
                            className="h-6 px-2 text-xs"
                            title={`Step ${session.number}: ${session.title}`}
                          >
                            Step {session.number}
                          </Button>
                        ))}
                      </div>
                      <div className="space-y-1">
                        {workflowForVariant.steps
                          .slice()
                          .sort((a, b) => a.number - b.number)
                          .map((step) => {
                            const isCurrent = workflowForVariant.currentStepId === step.id;
                            return (
                              <div
                                key={step.id}
                                className={`flex flex-wrap items-center gap-2 rounded border border-border/60 bg-background px-2 py-1 text-xs ${
                                  isCurrent ? 'border-foreground/30' : ''
                                }`}
                              >
                                <span
                                  className={`h-2 w-2 rounded-full ${workflowStatusDotClass(step.status)}`}
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleStartWorkflowStep(step.id)}
                                  disabled={workflowBusy}
                                  className="font-medium text-foreground hover:underline disabled:no-underline disabled:opacity-70"
                                >
                                  Step {step.number}: {step.title}
                                </button>
                                {step.pausePoint ? (
                                  <span className="text-muted-foreground">(pause)</span>
                                ) : null}
                                <span className="text-muted-foreground">
                                  chat:{' '}
                                  {step.conversationId ? (
                                    <code>{step.conversationId}</code>
                                  ) : (
                                    <code>none</code>
                                  )}
                                </span>
                                {step.status !== 'completed' ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void handleCompleteWorkflowStep(step)}
                                    disabled={workflowBusy || step.status === 'pending'}
                                    className="ml-auto h-6 px-2 text-xs"
                                  >
                                    <Check className="mr-1 h-3 w-3" />
                                    Complete
                                  </Button>
                                ) : (
                                  <span className="ml-auto text-green-600">done</span>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-foreground">Workflow:</span>
                      <Badge variant="outline">Scope: {getVariantDisplayLabel(v)}</Badge>
                      <Select
                        value={workflowTemplate}
                        onValueChange={(value) => setWorkflowTemplate(value as WorkflowTemplate)}
                      >
                        <SelectTrigger className="h-7 w-[160px] bg-background text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent side="top" className="z-[120]">
                          <SelectItem value="simple-prompt">Simple Prompt</SelectItem>
                          <SelectItem value="spec-and-build">Spec & Build</SelectItem>
                          <SelectItem value="full-sdd">Full SDD</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={workflowBusy || !isActive}
                        onClick={() => void handleInitWorkflowForActive()}
                        className="h-7 px-2.5 text-xs"
                      >
                        Init Active
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={workflowBusy}
                        onClick={() => void handleInitWorkflowForAll()}
                        className="h-7 px-2.5 text-xs"
                      >
                        Init All Agents
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-2 flex items-center justify-center px-4 py-2">
                <TooltipProvider delayDuration={250}>
                  <div className="flex items-center gap-2">
                    {variants.map((variant, tabIdx) => {
                      const asset = agentAssets[variant.agent];
                      const meta = agentMeta[variant.agent];
                      const isTabActive = tabIdx === activeTabIndex;
                      return (
                        <Tooltip key={variant.worktreeId}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => setActiveTabIndex(tabIdx)}
                              className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium transition-all ${
                                isTabActive
                                  ? 'border-2 border-foreground/30 bg-background text-foreground shadow-sm'
                                  : 'border border-border/50 bg-transparent text-muted-foreground hover:border-border/70 hover:bg-background/50 hover:text-foreground'
                              }`}
                            >
                              {asset?.logo ? (
                                <AgentLogo
                                  logo={asset.logo}
                                  alt={asset.alt || meta?.label || variant.agent}
                                  isSvg={asset.isSvg}
                                  invertInDark={asset.invertInDark}
                                  className="h-4 w-4 shrink-0"
                                />
                              ) : null}
                              <span>{getVariantDisplayLabel(variant)}</span>
                              {variantBusy[variant.worktreeId] ? (
                                <Spinner
                                  size="sm"
                                  className={
                                    isTabActive ? 'text-foreground' : 'text-muted-foreground'
                                  }
                                />
                              ) : null}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{variant.name}</p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </TooltipProvider>
              </div>
              <div className="min-h-0 flex-1 px-6 pt-4">
                <div
                  className={`mx-auto h-full max-w-4xl overflow-hidden rounded-md ${
                    v.agent === 'mistral'
                      ? isDark
                        ? 'bg-[#202938]'
                        : 'bg-white'
                      : isDark
                        ? 'bg-card'
                        : 'bg-white'
                  }`}
                >
                  <TerminalPane
                    ref={isActive ? activeTerminalRef : undefined}
                    id={getVariantTerminalId(v)}
                    cwd={v.path}
                    remote={
                      projectRemoteConnectionId
                        ? { connectionId: projectRemoteConnectionId }
                        : undefined
                    }
                    providerId={v.agent}
                    env={variantEnvs.get(v.worktreeId || v.path)}
                    autoApprove={
                      Boolean(task.metadata?.autoApprove) &&
                      Boolean(agentMeta[v.agent]?.autoApproveFlag)
                    }
                    initialPrompt={
                      agentMeta[v.agent]?.initialPromptFlag !== undefined &&
                      !agentMeta[v.agent]?.useKeystrokeInjection &&
                      !task.metadata?.initialInjectionSent
                        ? (initialInjection ?? undefined)
                        : undefined
                    }
                    keepAlive
                    mapShiftEnterToCtrlJ
                    variant={isDark ? 'dark' : 'light'}
                    themeOverride={
                      v.agent === 'mistral'
                        ? {
                            background:
                              effectiveTheme === 'dark-black'
                                ? '#141820'
                                : isDark
                                  ? '#202938'
                                  : '#ffffff',
                            selectionBackground: 'rgba(96, 165, 250, 0.35)',
                            selectionForeground: isDark ? '#f9fafb' : '#0f172a',
                          }
                        : effectiveTheme === 'dark-black'
                          ? {
                              background: '#000000',
                              selectionBackground: 'rgba(96, 165, 250, 0.35)',
                              selectionForeground: '#f9fafb',
                            }
                          : undefined
                    }
                    className="h-full w-full"
                    onStartSuccess={() => {
                      // For agents WITHOUT CLI flag support or with keystroke injection, type prompt in
                      if (
                        initialInjection &&
                        !task.metadata?.initialInjectionSent &&
                        (agentMeta[v.agent]?.initialPromptFlag === undefined ||
                          agentMeta[v.agent]?.useKeystrokeInjection)
                      ) {
                        void injectPrompt(getVariantTerminalId(v), v.agent, initialInjection);
                      }
                      // Mark initial injection as sent so it won't re-run on restart
                      if (initialInjection && !task.metadata?.initialInjectionSent) {
                        void window.electronAPI.saveTask({
                          ...task,
                          metadata: {
                            ...task.metadata,
                            initialInjectionSent: true,
                          },
                        });
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <div className="px-6 pb-6 pt-4">
        <div className="mx-auto max-w-4xl">
          <TaskMessageComposer
            value={prompt}
            onValueChange={setPrompt}
            onSubmit={() => void handleSendPrompt()}
            placeholder={
              promptTarget === 'active'
                ? 'Send a message to the active agent...'
                : 'Send a message to all agents...'
            }
            submitTitle={
              promptTarget === 'active'
                ? 'Send to active agent (Enter)'
                : 'Send to all agents (Enter)'
            }
            submitAriaLabel={
              promptTarget === 'active' ? 'Send to active agent' : 'Send to all agents'
            }
            mode={{
              value: promptTarget,
              onChange: (value) => setPromptTarget(value as 'active' | 'all'),
              options: [
                { value: 'all', label: 'All Agents' },
                { value: 'active', label: 'Active Agent' },
              ],
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default MultiAgentTask;
