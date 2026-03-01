import { ipcMain } from 'electron';
import { log } from '../lib/logger';
import { workflowService } from '../services/WorkflowService';
import type { WorkflowAutoMode, WorkflowTemplate } from '@shared/workflow/types';

export function registerWorkflowIpc(): void {
  ipcMain.handle(
    'workflow:create',
    async (
      _,
      args: {
        taskId: string;
        template: WorkflowTemplate;
        featureDescription: string;
        scopeKey?: string;
        taskPathOverride?: string;
      }
    ) => {
      try {
        const workflow = await workflowService.createWorkflow(args);
        return { success: true, workflow };
      } catch (error) {
        log.error('workflow:create failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(
    'workflow:get',
    async (_, args: { taskId: string; scopeKey?: string; taskPathOverride?: string }) => {
      try {
        const workflow = await workflowService.getWorkflow(
          args.taskId,
          args.scopeKey,
          args.taskPathOverride
        );
        return { success: true, workflow };
      } catch (error) {
        log.error('workflow:get failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(
    'workflow:startStep',
    async (
      _,
      args: {
        taskId: string;
        stepId: string;
        provider?: string;
        scopeKey?: string;
        taskPathOverride?: string;
      }
    ) => {
      try {
        const result = await workflowService.startStep(args);
        return { success: true, ...result };
      } catch (error) {
        log.error('workflow:startStep failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(
    'workflow:completeStep',
    async (
      _,
      args: { taskId: string; stepId: string; scopeKey?: string; taskPathOverride?: string }
    ) => {
      try {
        const workflow = await workflowService.completeStep(args);
        return { success: true, workflow };
      } catch (error) {
        log.error('workflow:completeStep failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(
    'workflow:nextStep',
    async (
      _,
      args: { taskId: string; provider?: string; scopeKey?: string; taskPathOverride?: string }
    ) => {
      try {
        const result = await workflowService.nextStep(args);
        return { success: true, result };
      } catch (error) {
        log.error('workflow:nextStep failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(
    'workflow:setAutoMode',
    async (
      _,
      args: {
        taskId: string;
        autoMode: WorkflowAutoMode;
        scopeKey?: string;
        taskPathOverride?: string;
      }
    ) => {
      try {
        const workflow = await workflowService.setAutoMode(args);
        return { success: true, workflow };
      } catch (error) {
        log.error('workflow:setAutoMode failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(
    'workflow:reparsePlan',
    async (_, args: { taskId: string; scopeKey?: string; taskPathOverride?: string }) => {
      try {
        const workflow = await workflowService.reparsePlan(
          args.taskId,
          args.scopeKey,
          args.taskPathOverride
        );
        return { success: true, workflow };
      } catch (error) {
        log.error('workflow:reparsePlan failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
}
