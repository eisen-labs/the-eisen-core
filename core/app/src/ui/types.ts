export interface AvailableAgent {
  id: string;
  name: string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
}

export interface FileSearchResult {
  path: string;
  fileName: string;
  relativePath: string;
  languageId: string;
  isDirectory: boolean;
}

export interface SessionMeta {
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string }> } | null;
  models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name?: string }> } | null;
}

export interface ContextChip {
  id: string;
  filePath: string;
  fileName: string;
  isDirectory?: boolean;
}
