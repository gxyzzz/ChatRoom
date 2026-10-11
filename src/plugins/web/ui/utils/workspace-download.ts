export function workspaceDownloadUrl(
  rootOrAlias: string,
  path: string,
  landing = false,
): string {
  const workspace = rootOrAlias.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const params = new URLSearchParams({ workspace, path });
  return `${landing ? "/download" : "/api/workspace/file/download"}?${params}`;
}
