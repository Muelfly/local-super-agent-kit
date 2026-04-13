import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';
import { launchDetached, runCommand } from './shell.js';

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

const defaultLmStudioCliPaths = (): string[] => {
  if (process.platform !== 'win32') {
    return ['lms'];
  }

  const home = process.env.USERPROFILE || '';
  return [
    path.join(home, '.lmstudio', 'bin', 'lms.exe'),
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

const resolveLmStudioCliPath = (): string | null => {
  const candidates = defaultLmStudioCliPaths();
  for (const candidate of candidates) {
    if (process.platform !== 'win32' || existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const startLmStudioLocalServer = async (config: RuntimeConfig): Promise<boolean> => {
  const cliPath = resolveLmStudioCliPath();
  if (!cliPath) {
    return false;
  }

  try {
    const result = await runCommand(cliPath, ['server', 'start'], config.rootDir);
    return result.code === 0;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const ensureLmStudio = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const initial = await checkLmStudio(config);
  if (initial.ok || !config.lmStudioAutoLaunch) {
    return initial;
  }

  const appPath = resolveLmStudioAppPath(config);
  const deadline = Date.now() + config.lmStudioHealthTimeoutMs;
  let appLaunchAttempted = false;
  let lastCliAttemptAt = 0;

  while (Date.now() < deadline) {
    const current = await checkLmStudio(config);
    if (current.ok) {
      return current;
    }

    const now = Date.now();
    if (now - lastCliAttemptAt >= 2_000) {
      lastCliAttemptAt = now;
      const cliStarted = await startLmStudioLocalServer(config);
      if (cliStarted) {
        await sleep(2_000);
        continue;
      }
    }

    if (!appLaunchAttempted && appPath) {
      await launchDetached(appPath, [], config.rootDir);
      appLaunchAttempted = true;
    }

    await sleep(2_000);
  }

  if (!appPath) {
    return {
      ok: false,
      detail: 'LM Studio is not reachable and no local app path could be resolved. Set LM_STUDIO_APP_PATH or run lms server start.',
    };
  }

  return {
    ok: false,
    detail: 'LM Studio app launched, but the local server did not become reachable in time. Try lms server start or enable the local server in LM Studio.',
  };
};
