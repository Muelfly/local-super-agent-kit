import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';
import { launchDetached } from './shell.js';

export type ServiceStatus = {
  ok: boolean;
  detail: string;
};

const buildModelsUrl = (baseUrl: string): string => {
  return `${baseUrl.replace(/\/$/u, '')}/models`;
};

export const checkLmStudio = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  try {
    const response = await fetch(buildModelsUrl(config.lmStudioBaseUrl));
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }

    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const models = Array.isArray(payload.data) ? payload.data.map((item) => item.id).filter(Boolean) : [];
    if (models.length === 0) {
      return { ok: true, detail: 'reachable, but no model is loaded yet' };
    }

    return { ok: true, detail: `reachable, loaded models: ${models.join(', ')}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'LM Studio unreachable' };
  }
};

const defaultWindowsAppPaths = (): string[] => {
  const home = process.env.USERPROFILE || '';
  return [
    path.join(home, 'AppData', 'Local', 'Programs', 'LM Studio', 'LM Studio.exe'),
    path.join(home, 'AppData', 'Local', 'LM-Studio', 'LM Studio.exe'),
    path.join('C:\\Program Files', 'LM Studio', 'LM Studio.exe'),
  ];
};

export const resolveLmStudioAppPath = (config: RuntimeConfig): string | null => {
  const candidates = [config.lmStudioAppPath, ...(process.platform === 'win32' ? defaultWindowsAppPaths() : [])]
    .map((item) => item.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const ensureLmStudio = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const initial = await checkLmStudio(config);
  if (initial.ok || !config.lmStudioAutoLaunch) {
    return initial;
  }

  const appPath = resolveLmStudioAppPath(config);
  if (!appPath) {
    return {
      ok: false,
      detail: 'LM Studio is not reachable and no local app path could be resolved. Set LM_STUDIO_APP_PATH.',
    };
  }

  await launchDetached(appPath, [], config.rootDir);

  const deadline = Date.now() + config.lmStudioHealthTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const current = await checkLmStudio(config);
    if (current.ok) {
      return current;
    }
  }

  return {
    ok: false,
    detail: 'LM Studio app launched, but the local server did not become reachable in time.',
  };
};
