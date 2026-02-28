// If providerId is supplied, scope the flag per provider; otherwise fall back to legacy key.
export const initialPromptSentKey = (taskId: string, providerId?: string, scopeId?: string) => {
  const trimmedProvider = providerId?.trim();
  const trimmedScope = scopeId?.trim();
  if (trimmedProvider && trimmedScope)
    return `initialPromptSent:${taskId}:${trimmedProvider}:${trimmedScope}`;
  if (trimmedProvider) return `initialPromptSent:${taskId}:${trimmedProvider}`;
  return `initialPromptSent:${taskId}`;
};
