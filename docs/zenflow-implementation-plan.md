# Zenflow-Style Workflow Plan for Emdash

## Current State
- Proposal source copied into this repo at `handoff-zenflow-in-emdash.md`.
- Emdash already has strong primitives we should reuse:
- Task metadata storage (`tasks.metadata`) and conversation metadata.
- Multi-conversation tabs per task with active conversation switching.
- Provider-aware PTY IDs and Claude session isolation in `ptyManager`.
- Filesystem IPC for read/write and plan lock signaling.

## Product Goal
Implement a first-class workflow mode where one feature task is decomposed into ordered steps, each step runs in its own chat session, and progress is controlled by a plan file plus UI controls (next, auto, pause, revisit).

## Scope and Non-Goals
- Scope for v1:
- Workflow types: `spec-and-build` and `full-sdd`.
- Plan-driven step list with statuses and pause points.
- One conversation session per step.
- Sequential execution and optional auto-chain.
- Artifact folder per workflow.
- Non-goals for v1:
- Parallel step execution.
- Reviewer persona automation.
- Remote SSH parity for all workflow features (keep local first).

## Architecture Choice
Use existing `Task` and `Conversation` records instead of introducing new top-level DB tables in v1.

- Store workflow state inside `tasks.metadata.workflow`.
- Store per-step chat linkage in `conversations.metadata.workflowStepId`.
- Persist `plan.md` under task path for transparency and portability.

This avoids risky migrations up front and lets us iterate quickly. If v1 is successful, we can promote to dedicated DB tables in v2.

## Filesystem Layout (v1)
Use a task-local directory:
- `.emdash/workflow/plan.md`
- `.emdash/workflow/requirements.md`
- `.emdash/workflow/spec.md`
- `.emdash/workflow/report.md`
- `.emdash/workflow/steps/step-<n>-<slug>.md` (optional generated briefs)

Reason: keeps data tied to the task worktree, survives agent/session restarts, and aligns with existing `.emdash` usage.

## Data Contract (Task Metadata)
Add typed metadata in renderer and main types:

- `workflow.enabled: boolean`
- `workflow.type: 'spec-and-build' | 'full-sdd'`
- `workflow.status: 'planning' | 'in_progress' | 'paused' | 'completed' | 'blocked'`
- `workflow.autoMode: 'manual' | 'auto'`
- `workflow.currentStepId: string | null`
- `workflow.planPath: string`
- `workflow.artifactsDir: string`
- `workflow.steps: WorkflowStep[]`

`WorkflowStep`:
- `id: string` (stable, eg `step-1-requirements`)
- `number: number`
- `title: string`
- `instructions: string`
- `status: 'pending' | 'in_progress' | 'completed' | 'blocked'`
- `pausePoint: boolean`
- `conversationId: string | null`
- `artifacts: string[]`
- `startedAt?: string`
- `completedAt?: string`

## Plan Markdown Contract
Define one parser/serializer pair and treat it as the source of truth for human readability.

- Header section with workflow metadata.
- Step list with status marker:
- `[ ]` pending
- `[x]` completed
- `[!]` blocked
- `[>]` in progress
- Each step line stores:
- Step number/title
- pause flag
- conversation id (if present)
- artifact links

Store canonical machine data in task metadata, and regenerate `plan.md` from metadata after state changes.

## Execution Model
- Each workflow step gets a dedicated conversation record.
- PTY id uses existing chat format:
- `makePtyId(provider, 'chat', conversationId)`
- Step start builds a structured prompt containing:
- feature goal
- step instructions
- required artifacts to read
- artifact output requirements
- completion instructions

Completion policy in v1:
- Manual complete action in UI is authoritative.
- Optional soft auto-detect on PTY exit to suggest completion.

## Implementation Phases

### Phase 0: Hard Decisions and Contracts
- Confirm directory layout (`.emdash/workflow`).
- Confirm v1 completion model (manual-first).
- Confirm v1 provider scope (all terminal providers vs Claude-first).
- Define typed interfaces in shared/renderer.

Deliverable:
- Approved contract doc and TypeScript types.

### Phase 1: Core Workflow Service (Main Process)
Create `src/main/services/WorkflowService.ts`.

Responsibilities:
- Initialize workflow metadata for a task.
- Create/read/write `plan.md`.
- Create/read artifact directory.
- Parse plan markdown and merge back into metadata.
- CRUD operations for step status and dynamic step insertion.

Add unit tests:
- `src/test/main/WorkflowService.test.ts`

Deliverable:
- Service APIs tested without UI dependencies.

### Phase 2: IPC Surface + Preload + Types
Add `src/main/ipc/workflowIpc.ts` and register in `src/main/ipc/index.ts`.

IPC methods:
- `workflow:create`
- `workflow:get`
- `workflow:updateMode` (manual/auto)
- `workflow:startStep`
- `workflow:completeStep`
- `workflow:blockStep`
- `workflow:nextStep`
- `workflow:reparsePlan`
- `workflow:appendSteps` (for planning step expansion)

Also update:
- `src/main/preload.ts`
- `src/renderer/types/electron-api.d.ts`

Deliverable:
- Typed renderer API for workflow operations.

### Phase 3: Step Session Orchestrator
Create `src/main/services/WorkflowOrchestratorService.ts`.

Responsibilities:
- Ensure per-step conversation exists.
- Start PTY for step conversation with step prompt.
- Track running step state.
- Handle pause points and auto-chain transitions.
- Emit workflow events to renderer (similar to lifecycle events).

Integration points:
- `DatabaseService` conversation creation/activation.
- PTY start APIs via existing IPC/service boundaries.
- `agent:event`/pty exit listeners for status updates.

Deliverable:
- Workflow can run sequentially across step chats without UI polish.

### Phase 4: Renderer State + Hooks
Add renderer hook(s):
- `src/renderer/hooks/useWorkflow.ts`
- optional `useWorkflowEvents.ts`

Responsibilities:
- Load workflow state for active task.
- Dispatch IPC commands.
- Keep task metadata and UI state synchronized.
- Control auto/manual mode and current running step.

Deliverable:
- Reactive workflow state available to components.

### Phase 5: Workflow UI (Task Experience)
Add new components:
- `src/renderer/components/workflow/WorkflowPlanPanel.tsx`
- `src/renderer/components/workflow/WorkflowControls.tsx`
- `src/renderer/components/workflow/WorkflowStepList.tsx`

Integration approach:
- For workflow-enabled tasks, render plan panel alongside existing `ChatInterface`.
- Reuse current conversation tabs; clicking a step switches to that step's conversation.

Controls:
- `Next`
- `Auto-run`
- `Pause`
- `Mark complete`
- `Re-parse plan`

Deliverable:
- End-to-end workflow UX with revisit and controls.

### Phase 6: Task Creation / Launcher UX
Extend `TaskModal` with workflow options:
- Task mode: Standard or Workflow.
- Workflow template: Spec & Build or Full SDD.
- Feature description input.

On create:
- Create task as today.
- Initialize workflow metadata + plan file.
- Auto-create first step conversation.
- Focus that conversation.

Deliverable:
- User can create workflow task from UI without manual setup.

### Phase 7: Dynamic Plan Expansion
Planning step can add implementation steps.

Mechanics:
- UI action `Re-parse plan` or automatic reparse after step completion.
- Parser detects new steps and merges into metadata while preserving existing conversation links/status.
- New steps default to pending and no conversation until first run.

Deliverable:
- Step 3 style expansion supported reliably.

### Phase 8: Tests and Validation
Main tests:
- Workflow service parser/serializer idempotence.
- Step transition state machine.
- Auto-chain pause behavior.
- Dynamic insertion merge behavior.

Renderer tests:
- Plan panel renders statuses.
- Step click activates conversation.
- Control buttons trigger IPC and state updates.

Manual QA script:
- Create full SDD workflow.
- Complete steps 1-3 with pause gates.
- Expand plan to N steps.
- Auto-run steps 4..N.
- Revisit step 2 and continue chat.

### Phase 9: Guardrails and Telemetry
Add telemetry events:
- `workflow_created`
- `workflow_step_started`
- `workflow_step_completed`
- `workflow_paused`
- `workflow_auto_mode_changed`

Guardrails:
- Block auto-run if a step is blocked.
- Single running step per workflow.
- Explicit recovery path if PTY crashes mid-step.

Deliverable:
- Observable behavior and safer failure handling.

## Detailed Task Breakdown by File Area

Main process:
- `src/main/services/WorkflowService.ts` (new)
- `src/main/services/WorkflowOrchestratorService.ts` (new)
- `src/main/ipc/workflowIpc.ts` (new)
- `src/main/ipc/index.ts` (register)
- `src/main/preload.ts` (bridge)
- `src/main/services/DatabaseService.ts` (typed helpers for workflow metadata/conversation metadata)

Shared/Types:
- `src/shared/workflow/types.ts` (new)
- `src/renderer/types/chat.ts` (extend `TaskMetadata`)
- `src/renderer/types/electron-api.d.ts` (new IPC methods/events)

Renderer:
- `src/renderer/hooks/useWorkflow.ts` (new)
- `src/renderer/components/workflow/*` (new)
- `src/renderer/components/TaskModal.tsx` (launcher options)
- `src/renderer/components/MainContentArea.tsx` (workflow layout integration)
- `src/renderer/components/ChatInterface.tsx` (step-aware conversation switching hooks)

Tests:
- `src/test/main/WorkflowService.test.ts` (new)
- `src/test/main/WorkflowOrchestratorService.test.ts` (new)
- `src/test/renderer/WorkflowPlanPanel.test.tsx` (new)

## Risk Register and Mitigations
- Risk: plan markdown drift from metadata.
- Mitigation: metadata is canonical; plan file is generated after every state change.

- Risk: unreliable automatic step completion detection.
- Mitigation: manual completion as source of truth in v1.

- Risk: provider-specific prompt injection behavior.
- Mitigation: reuse existing `initialPrompt` flow and keep Claude-first QA.

- Risk: UI complexity in existing `ChatInterface`.
- Mitigation: isolate workflow UI into dedicated components and integrate minimally.

## Rollout Strategy
- Milestone A: Service + IPC + CLI-less tests (no UI).
- Milestone B: Basic UI and manual step flow.
- Milestone C: Auto-chain + dynamic expansion.
- Milestone D: polish, telemetry, docs.

Keep behind a feature flag until Milestone C is stable.

## Definition of Done (v1)
- User can create a workflow task (both templates).
- Each step has its own persistent conversation.
- Plan view shows accurate state and allows step navigation.
- Pause gates and auto-run mode work.
- Planning step can add new implementation steps.
- Tests pass: format, lint, type-check, vitest.
