export function workspaceDownloadUrl(
  workspaceId: string,
  path: string,
  landing = false,
): string {
  const params = new URLSearchParams({ workspaceId, path });
  return `${landing ? "/download" : "/api/workspace/file/download"}?${params}`;
}
