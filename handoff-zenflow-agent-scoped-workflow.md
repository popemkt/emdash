# Handoff: Zenflow-Style Agent-Scoped Orchestration in Emdash

Date: March 1, 2026
Branch: `emdash/zenflow-orchestration-codex-7dl`

## 1) Request and Scope
This implementation was driven by the following requirements:

1. Keep Emdash workflow behavior mostly the same.
2. Use Zenflow-style orchestration with a `plan.md` control file.
3. Keep step-to-chat linkage via comments in `plan.md` (chat id under each step).
4. Use `.zenflow` plan location (not `.emdash/workflow`).
5. Support multiple agents per task, with workflow state/plan scoped by active agent tab.
6. Auto-reparse plan updates.
7. Validate thoroughly and commit incrementally.

## 2) Final Behavior Implemented

### 2.1 Workflow remains familiar, orchestration is layered on top
- Existing task + conversation model remains in place.
- Workflow orchestration is added via workflow state, step lifecycle, and step-chat prompts.
- Each workflow step can launch/attach to a dedicated conversation.

### 2.2 Plan file now lives in `.zenflow` and is scope-aware
- Root is now `.zenflow`.
- Scope paths:
  - Default scope: `.zenflow/<taskId>/plan.md`
  - Agent scope: `.zenflow/<taskId>/<scopeKey>/plan.md`
- Scope key is normalized (lowercase, slug-like).

### 2.3 Per-agent tab workflow isolation
- Workflow state is keyed by scope in task metadata (`metadata.workflows[scopeKey]`).
- In UI, the active conversation provider determines current `scopeKey`.
- Switching tabs switches workflow scope and loads that scope's steps/plan.

### 2.4 Step <-> chat linkage preserved
- `plan.md` keeps `<!-- emdash:chat-id=... -->` under each step.
- Step IDs and pause-point comments are persisted as well.

### 2.5 Auto-reparse behavior
- Backend reparses/syncs from `plan.md` on `getWorkflow` and step actions.
- Renderer performs periodic refresh (`workflowGet`) every 2.5 seconds.

## 3) Implementation Details by Layer

### 3.1 Shared workflow types
File: `src/shared/workflow/types.ts`
- Added `scopeKey: string` to `WorkflowState`.

### 3.2 Main process workflow service
File: `src/main/services/WorkflowService.ts`

Key changes:
- Switched storage root constant to `.zenflow`.
- Added scope normalization and scoped path resolver.
- Added scoped workflow storage model:
  - `metadata.workflows` for all scopes.
  - Backward compatibility fallback to legacy `metadata.workflow` for default scope.
- Added helper logic to sync workflow from plan markdown.
- All public service methods now support optional `scopeKey`:
  - `createWorkflow`, `getWorkflow`, `startStep`, `completeStep`, `nextStep`, `setAutoMode`, `reparsePlan`.
- Plan rendering includes scope line (`Scope: <scopeKey>`).

### 3.3 IPC contracts
File: `src/main/ipc/workflowIpc.ts`
- Added optional `scopeKey` to all workflow IPC payloads.

### 3.4 Preload bridge
File: `src/main/preload.ts`
- Added optional `scopeKey` in all exposed workflow bridge methods.

### 3.5 Renderer API types
File: `src/renderer/types/electron-api.d.ts`
- Added optional `scopeKey` across workflow method signatures in both declarations.

### 3.6 Task metadata typing
File: `src/renderer/types/chat.ts`
- Added `workflows?: Record<string, WorkflowState> | null`.
- Kept legacy `workflow?: WorkflowState | null` for compatibility.

### 3.7 Chat UI workflow behavior
File: `src/renderer/components/ChatInterface.tsx`

Key changes:
- Added `normalizeWorkflowScopeKey()` helper.
- Computes active workflow scope from active conversation provider (fallback to current agent).
- All workflow calls now pass `scopeKey` (and provider when needed).
- Removed direct initialization from `task.metadata.workflow` and loads from scoped API.
- Added 2.5s polling refresh for auto-reparse UX.
- Added scope badge in workflow controls (`Scope: <scopeKey>`), so users can see which agent scope is active.

## 4) Test Coverage Added

File: `src/test/main/WorkflowService.test.ts`

Tests added:
1. `stores scoped workflows under .zenflow/<taskId>/<scope>/plan.md`
   - Verifies `planRelPath`, `artifactsDirRelPath`, file creation, and metadata scope storage.
2. `keeps workflow plans isolated per agent scope`
   - Creates `codex` and `claude` scopes.
   - Mutates only codex plan file.
   - Verifies reparsed codex step title changes while claude remains unchanged.

## 5) Commit Timeline (Incremental)

### Earlier implementation set
1. `91cef0e0` `feat(workflow): add core workflow service and IPC`
   - Added initial workflow service, IPC, preload, shared types, and API types.
2. `e92a4f5b` `feat(workflow-ui): add plan controls and per-step chat prompts`
   - Added workflow controls/prompt behavior in Chat UI.
3. `13d95388` `docs(workflow): add zenflow handoff and implementation plan`
   - Added docs and first handoff.

### Agent-scoped + .zenflow set
4. `437e0449` `feat(workflow): add agent-scoped zenflow orchestration state`
   - Added scope-aware backend/service/IPC/type plumbing.
5. `25ee9c1e` `feat(workflow-ui): scope workflow state by active agent tab`
   - Added scope-aware Chat UI loading/actions + auto-refresh.
6. `30a415ca` `test(workflow): cover zenflow scope paths and isolation`
   - Added workflow scope tests.

## 6) Validation and Results

Commands run:
- `pnpm run format` -> passed
- `pnpm run lint` -> passed (warnings only, no errors)
- `pnpm run type-check` -> passed
- `pnpm exec vitest run` -> passed (29 files, 273 tests)

Notes:
- Engine warning appears because local node is `v24.13.0` while project expects `<23`.
- This warning did not block successful checks.

## 7) Playwright MCP Verification

Performed browser smoke verification against renderer UI:
- Opened task view and workflow controls.
- Created additional chat on a different provider (`codex`).
- Verified workflow scope badge switches between `Scope: codex` and `Scope: claude` when switching tabs.

Important caveat:
- Direct `window.electronAPI.workflow*` calls from the browser-dev harness returned legacy `.emdash/workflow/plan.md` values because this harness uses a mocked API layer, not the real Electron main process wiring.
- Source code and Vitest backend coverage validate the real pathing logic is `.zenflow/...` in main-process service.

## 8) Files Touched Across the Full Effort

### Core workflow backend
- `src/main/services/WorkflowService.ts`
- `src/main/ipc/workflowIpc.ts`
- `src/main/ipc/index.ts` (initial registration)
- `src/main/preload.ts`
- `src/main/services/DatabaseService.ts` (initial workflow support)

### Shared and API typing
- `src/shared/workflow/types.ts`
- `src/renderer/types/electron-api.d.ts`
- `src/renderer/types/chat.ts`

### Renderer UX
- `src/renderer/components/ChatInterface.tsx`
- `src/renderer/hooks/useInitialPromptInjection.ts` (initial workflow UI phase)
- `src/renderer/lib/keys.ts` (initial workflow UI phase)

### Tests and docs
- `src/test/main/WorkflowService.test.ts`
- `docs/zenflow-implementation-plan.md`
- `handoff-zenflow-in-emdash.md`
- `handoff-zenflow-agent-scoped-workflow.md` (this file)

## 9) Current Status
- Working tree is clean.
- All requested scoped orchestration behavior is implemented and tested.
- Incremental commits are complete.
