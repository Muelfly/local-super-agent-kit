import type { RuntimeConfig } from './env.js';
import { commandExists, launchDetachedShell, runCommand, runShellCommand } from './shell.js';
import type { ServiceStatus } from './lmStudio.js';

const buildModelsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/$/u, '')}/models`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const checkOpenJarvis = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.openJarvisEnabled) {
    return { ok: true, detail: 'disabled' };
  }

  try {
    const response = await fetch(buildModelsUrl(config.openJarvisBaseUrl), {
      headers: config.openJarvisApiKey
        ? { Authorization: `Bearer ${config.openJarvisApiKey}` }
        : {},
    });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const models = Array.isArray(payload.data)
      ? payload.data.map((item) => String(item.id ?? '').trim()).filter(Boolean)
      : [];
    const evalHook = config.openJarvisEvalCommand ? 'eval hook configured' : 'eval hook not configured';
    const modelDetail = models.length > 0 ? `models: ${models.join(', ')}` : 'no models listed';
    return { ok: true, detail: `${modelDetail}; ${evalHook}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'OpenJarvis unreachable' };
  }
};

export const ensureOpenJarvis = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const initial = await checkOpenJarvis(config);
  if (initial.ok || !config.openJarvisServeCommand) {
    return initial;
  }

  await launchDetachedShell(config.openJarvisServeCommand, config.rootDir);
  return checkOpenJarvis(config);
};

export const checkN8n = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.n8nEnabled) {
    return { ok: true, detail: 'disabled' };
  }

  try {
    const response = await fetch(`${config.n8nBaseUrl.replace(/\/$/u, '')}/healthz`);
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    return { ok: true, detail: 'reachable' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'n8n unreachable' };
  }
};

export const ensureN8n = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const initial = await checkN8n(config);
  if (initial.ok || !config.n8nEnabled) {
    return initial;
  }

  await runShellCommand(config.n8nStartCommand, config.rootDir);
  return checkN8n(config);
};

export const checkControlPlane = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.controlPlaneEnabled) {
    return { ok: true, detail: 'disabled' };
  }

  try {
    const response = await fetch(`${config.controlPlaneBaseUrl.replace(/\/$/u, '')}/healthz`);
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    return { ok: true, detail: 'reachable' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'control plane unreachable' };
  }
};

export const ensureControlPlane = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const initial = await checkControlPlane(config);
  if (initial.ok || !config.controlPlaneEnabled) {
    return initial;
  }

  await launchDetachedShell(config.controlPlaneStartCommand, config.rootDir);
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await checkControlPlane(config);
    if (current.ok) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) {
    return { ok: false, detail: 'control plane launch was attempted, but health checks did not pass in time' };
  }

  return checkControlPlane(config);
};

export const checkNemoClaw = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.nemoClawEnabled) {
    return { ok: true, detail: 'disabled' };
  }

  const exists = await commandExists(config.nemoClawCommand, config.rootDir);
  if (!exists) {
    return {
      ok: false,
      detail: `command not found: ${config.nemoClawCommand}`,
    };
  }

  const result = await runCommand(config.nemoClawCommand, config.nemoClawStatusArgs, config.rootDir);
  if (result.code === 0) {
    return { ok: true, detail: result.stdout || 'installed' };
  }

  return { ok: false, detail: result.stderr || result.stdout || 'status command failed' };
};

export const ensureNemoClaw = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const initial = await checkNemoClaw(config);
  if (initial.ok || !config.nemoClawEnabled || !config.nemoClawSetupCommand) {
    return initial;
  }

  const setup = await runShellCommand(config.nemoClawSetupCommand, config.rootDir);
  if (setup.code !== 0) {
    return {
      ok: false,
      detail: setup.stderr || setup.stdout || 'setup command failed',
    };
  }

  return checkNemoClaw(config);
};
