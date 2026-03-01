import React, { useCallback, useRef, useState } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { PanelLeftOpen } from 'lucide-react';
import ChatInterface from './ChatInterface';
import KanbanBoard from './kanban/KanbanBoard';
import MultiAgentTask from './MultiAgentTask';
import ProjectMainView from './ProjectMainView';
import HomeView from './HomeView';
import SkillsView from './skills/SkillsView';
import SettingsPage from './SettingsPage';
import TaskCreationLoading from './TaskCreationLoading';
import TaskWorkspaceSidebar from './TaskWorkspaceSidebar';
import { Button } from './ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import type { Agent } from '../types';
import type { Project, Task } from '../types/app';
import type { SettingsPageTab } from '../hooks/useModalState';

interface MainContentAreaProps {
  selectedProject: Project | null;
  activeTask: Task | null;
  activeTaskAgent: Agent | null;
  isCreatingTask: boolean;
  onTaskInterfaceReady: () => void;
  showKanban: boolean;
  showHomeView: boolean;
  showSkillsView: boolean;
  showSettingsPage: boolean;
  settingsPageInitialTab?: SettingsPageTab;
  handleCloseSettingsPage?: () => void;
  projectDefaultBranch: string;
  projectBranchOptions: Array<{ value: string; label: string }>;
  isLoadingBranches: boolean;
  setProjectDefaultBranch: (branch: string) => void;
  handleSelectTask: (task: Task) => void;
  handleDeleteTask: (
    project: Project,
    task: Task,
    options?: { silent?: boolean }
  ) => Promise<boolean>;
  handleArchiveTask: (
    project: Project,
    task: Task,
    options?: { silent?: boolean }
  ) => Promise<boolean>;
  handleRestoreTask?: (project: Project, task: Task) => Promise<void>;
  handleDeleteProject: (project: Project) => Promise<void>;
  handleOpenProject: () => void;
  handleNewProjectClick: () => void;
  handleCloneProjectClick: () => void;
  handleAddRemoteProject: () => void;
  setShowTaskModal: (show: boolean) => void;
  setShowKanban: (show: boolean) => void;
  projectRemoteConnectionId?: string | null;
  projectRemotePath?: string | null;
}

const MainContentArea: React.FC<MainContentAreaProps> = ({
  selectedProject,
  activeTask,
  activeTaskAgent,
  isCreatingTask,
  onTaskInterfaceReady,
  showKanban,
  showHomeView,
  showSkillsView,
  showSettingsPage,
  settingsPageInitialTab,
  handleCloseSettingsPage,
  projectDefaultBranch,
  projectBranchOptions,
  isLoadingBranches,
  setProjectDefaultBranch,
  handleSelectTask,
  handleDeleteTask,
  handleArchiveTask,
  handleRestoreTask,
  handleDeleteProject,
  handleOpenProject,
  handleNewProjectClick,
  handleCloneProjectClick,
  handleAddRemoteProject,
  setShowTaskModal,
  setShowKanban,
  projectRemoteConnectionId,
  projectRemotePath,
}) => {
  const secondaryPanelRef = useRef<ImperativePanelHandle | null>(null);
  const [isSecondarySidebarCollapsed, setIsSecondarySidebarCollapsed] = useState(false);

  const handleToggleSecondarySidebar = useCallback(() => {
    const panel = secondaryPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setIsSecondarySidebarCollapsed(false);
      return;
    }
    panel.collapse();
    setIsSecondarySidebarCollapsed(true);
  }, []);

  if (showSettingsPage) {
    return (
      <div className="relative z-40 flex min-h-0 flex-1 overflow-hidden bg-background">
        <SettingsPage
          initialTab={settingsPageInitialTab}
          onClose={handleCloseSettingsPage || (() => {})}
        />
      </div>
    );
  }

  if (selectedProject && showKanban) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <KanbanBoard
          project={selectedProject}
          onOpenTask={(ws: any) => {
            handleSelectTask(ws);
            setShowKanban(false);
          }}
          onCreateTask={() => setShowTaskModal(true)}
        />
      </div>
    );
  }

  if (showSkillsView) {
    return <SkillsView />;
  }

  if (showHomeView) {
    return (
      <HomeView
        onOpenProject={handleOpenProject}
        onNewProjectClick={handleNewProjectClick}
        onCloneProjectClick={handleCloneProjectClick}
        onAddRemoteProject={handleAddRemoteProject}
      />
    );
  }

  if (selectedProject) {
    const taskMainView = activeTask ? (
      (activeTask.metadata as any)?.multiAgent?.enabled ? (
        <MultiAgentTask
          task={activeTask}
          projectName={selectedProject.name}
          projectId={selectedProject.id}
          projectPath={selectedProject.path}
          projectRemoteConnectionId={projectRemoteConnectionId}
          projectRemotePath={projectRemotePath}
          defaultBranch={projectDefaultBranch}
          onTaskInterfaceReady={onTaskInterfaceReady}
        />
      ) : (
        <ChatInterface
          task={activeTask}
          projectName={selectedProject.name}
          projectPath={selectedProject.path}
          projectRemoteConnectionId={projectRemoteConnectionId}
          projectRemotePath={projectRemotePath}
          defaultBranch={projectDefaultBranch}
          className="min-h-0 flex-1"
          initialAgent={activeTaskAgent || undefined}
          onTaskInterfaceReady={onTaskInterfaceReady}
        />
      )
    ) : null;

    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTask ? (
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <ResizablePanelGroup direction="horizontal" className="h-full w-full">
              <ResizablePanel
                ref={secondaryPanelRef}
                className="min-h-0"
                defaultSize={24}
                minSize={18}
                maxSize={40}
                collapsedSize={0}
                collapsible
                order={1}
                onCollapse={() => setIsSecondarySidebarCollapsed(true)}
                onExpand={() => setIsSecondarySidebarCollapsed(false)}
              >
                <TaskWorkspaceSidebar
                  task={activeTask}
                  activeTaskAgent={activeTaskAgent}
                  onCollapse={handleToggleSecondarySidebar}
                />
              </ResizablePanel>
              <ResizableHandle
                withHandle
                className="hidden cursor-col-resize items-center justify-center transition-colors hover:bg-border/80 sm:flex"
              />
              <ResizablePanel className="min-h-0" minSize={55} order={2}>
                {taskMainView}
              </ResizablePanel>
            </ResizablePanelGroup>
            {isSecondarySidebarCollapsed ? (
              <div className="pointer-events-none absolute left-3 top-3 z-20">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="pointer-events-auto h-8 gap-1.5 bg-background/95 text-xs shadow-sm backdrop-blur"
                  onClick={handleToggleSecondarySidebar}
                  title="Expand sidebar"
                  aria-label="Expand task workspace sidebar"
                >
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                  Show Sidebar
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <ProjectMainView
            project={selectedProject}
            onCreateTask={() => setShowTaskModal(true)}
            activeTask={activeTask}
            onSelectTask={handleSelectTask}
            onDeleteTask={handleDeleteTask}
            onArchiveTask={handleArchiveTask}
            onRestoreTask={handleRestoreTask}
            onDeleteProject={handleDeleteProject}
            branchOptions={projectBranchOptions}
            isLoadingBranches={isLoadingBranches}
            onBaseBranchChange={setProjectDefaultBranch}
          />
        )}

        {isCreatingTask && (
          <div className="absolute inset-0 z-10 bg-background">
            <TaskCreationLoading />
          </div>
        )}
      </div>
    );
  }

  return null;
};

export default MainContentArea;
