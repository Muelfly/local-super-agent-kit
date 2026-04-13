import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';
import { commandExists, launchDetachedShell, runCommand, runShellCommand } from './shell.js';
import type { ServiceStatus } from './lmStudio.js';
import { ensureN8nAutomationAccess, getN8nAccessStatus, waitForN8nReachable } from './n8n.js';

const buildModelsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/$/u, '')}/models`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const deriveRootUrl = (baseUrl: string): string => baseUrl.replace(/\/$/u, '').replace(/\/v1$/u, '');

const waitForService = async (check: () => Promise<ServiceStatus>, attempts = 20, delayMs = 500): Promise<ServiceStatus> => {
  let last = await check();
  if (last.ok) {
    return last;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(delayMs);
    last = await check();
    if (last.ok) {
      return last;
    }
  }

  return last;
};

const installBinary = async (commandLine: string, cwd: string): Promise<ServiceStatus> => {
  if (!commandLine.trim()) {
    return { ok: false, detail: 'install command is not configured' };
  }

  const result = await runShellCommand(commandLine, cwd);
  if (result.code !== 0) {
    return {
      ok: false,
      detail: result.stderr || result.stdout || 'install command failed',
    };
  }

  return { ok: true, detail: result.stdout || 'installed' };
};

const resolveWindowsHermesShimPath = (): string | null => {
  if (process.platform !== 'win32') {
    return null;
  }

  const homeDir = process.env.USERPROFILE?.trim();
  return homeDir ? path.join(homeDir, 'bin', 'hermes.cmd') : null;
};

const resolveWslHome = async (cwd: string): Promise<string | null> => {
  if (process.platform !== 'win32') {
    return null;
  }

  const result = await runCommand('wsl.exe', ['--', 'bash', '-lc', 'printf %s "$HOME"'], cwd);
  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  return result.stdout.trim();
};

const ensureWindowsHermesShim = async (cwd: string): Promise<ServiceStatus> => {
  if (process.platform !== 'win32') {
    return { ok: true, detail: 'not needed' };
  }

  const shimPath = resolveWindowsHermesShimPath();
  const wslHome = await resolveWslHome(cwd);
  if (!shimPath || !wslHome) {
    return { ok: false, detail: 'could not resolve a WSL home directory for the Hermes Windows shim' };
  }

  await mkdir(path.dirname(shimPath), { recursive: true });
  const linuxHermesPath = `${wslHome}/.hermes/hermes-agent/venv/bin/hermes`;
  const shim = `@echo off\r\nwsl.exe -- ${linuxHermesPath} %*\r\n`;
  await writeFile(shimPath, shim, 'utf8');
  return { ok: true, detail: shimPath };
};

const ensureOpenClawInstalled = async (config: RuntimeConfig): Promise<ServiceStatus | null> => {
  const exists = await commandExists(config.openClawCommand, config.rootDir);
  if (exists) {
    return null;
  }

  const install = await installBinary(config.openClawInstallCommand, config.rootDir);
  if (!install.ok) {
    return install;
  }

  const ready = await commandExists(config.openClawCommand, config.rootDir);
  if (!ready) {
    return {
      ok: false,
      detail: `OpenClaw install completed, but command was not found at ${config.openClawCommand}`,
    };
  }

  return { ok: true, detail: 'OpenClaw CLI installed' };
};

const ensureHermesInstalled = async (config: RuntimeConfig): Promise<ServiceStatus | null> => {
  const exists = await commandExists(config.hermesCommand, config.rootDir);
  if (exists) {
    return null;
  }

  const install = await installBinary(config.hermesInstallCommand, config.rootDir);
  if (!install.ok) {
    return install;
  }

  const shim = await ensureWindowsHermesShim(config.rootDir);
  if (!shim.ok) {
    return shim;
  }

  const ready = await commandExists(config.hermesCommand, config.rootDir);
  if (!ready) {
    return {
      ok: false,
      detail: `Hermes install completed, but command was not found at ${config.hermesCommand}`,
    };
  }

  return { ok: true, detail: 'Hermes CLI installed' };
};

const writeManagedLauncher = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o755);
  }
};

const ensureOpenJarvisInstalled = async (config: RuntimeConfig): Promise<ServiceStatus | null> => {
  const exists = await commandExists(config.openJarvisCommand, config.rootDir);
  if (exists) {
    return null;
  }

  const hasUvx = await commandExists('uvx', config.rootDir);
  if (!hasUvx) {
    return {
      ok: false,
      detail: 'OpenJarvis provisioning requires uvx from Astral uv. Install uv and rerun bootstrap.',
    };
  }

  if (!path.isAbsolute(config.openJarvisCommand)) {
    return {
      ok: false,
      detail: `OpenJarvis command was not found and cannot be auto-managed: ${config.openJarvisCommand}`,
    };
  }

  const launcher = process.platform === 'win32'
    ? '@echo off\r\nuvx --from OpenJarvis[server] jarvis %*\r\n'
    : '#!/usr/bin/env bash\nexec uvx --from OpenJarvis[server] jarvis "$@"\n';
  await writeManagedLauncher(config.openJarvisCommand, launcher);

  const verify = await runCommand(config.openJarvisCommand, ['--version'], config.rootDir);
  if (verify.code !== 0) {
    return {
      ok: false,
      detail: verify.stderr || verify.stdout || 'OpenJarvis launcher provisioning failed',
    };
  }

  return { ok: true, detail: 'OpenJarvis launcher provisioned' };
};

const readOpenJarvisRuntimeDetail = async (config: RuntimeConfig): Promise<string | null> => {
  const exists = await commandExists(config.openJarvisCommand, config.rootDir);
  if (!exists || config.openJarvisStatusArgs.length === 0) {
    return null;
  }

  const result = await runCommand(config.openJarvisCommand, config.openJarvisStatusArgs, config.rootDir);
  const output = result.stdout || result.stderr;
  return output || null;
};

const ensureNemoClawLauncher = async (config: RuntimeConfig): Promise<ServiceStatus | null> => {
  if (!path.isAbsolute(config.nemoClawCommand)) {
    return null;
  }

  if (process.platform === 'win32') {
    const wslHome = await resolveWslHome(config.rootDir);
    if (!wslHome) {
      return { ok: false, detail: 'could not resolve a WSL home directory for the NemoClaw Windows launcher' };
    }

    const launcher = `@echo off\r\nwsl.exe -- ${wslHome}/.local/bin/nemoclaw %*\r\n`;
    await writeManagedLauncher(config.nemoClawCommand, launcher);
  } else {
    await writeManagedLauncher(config.nemoClawCommand, '#!/usr/bin/env bash\nexec "$HOME/.local/bin/nemoclaw" "$@"\n');
  }

  const verify = await runCommand(config.nemoClawCommand, ['--version'], config.rootDir);
  if (verify.code !== 0) {
    return {
      ok: false,
      detail: verify.stderr || verify.stdout || 'NemoClaw launcher provisioning failed',
    };
  }

  return { ok: true, detail: 'NemoClaw launcher provisioned' };
};

export const checkOpenJarvis = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.openJarvisEnabled) {
    return { ok: false, detail: 'disabled, but this package expects OpenJarvis to be present' };
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
    const runtimeDetail = await readOpenJarvisRuntimeDetail(config);
    const detail = error instanceof Error ? error.message : 'OpenJarvis unreachable';
    return { ok: false, detail: runtimeDetail ? `${detail}; jarvis: ${runtimeDetail}` : detail };
  }
};

export const ensureOpenJarvis = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const install = await ensureOpenJarvisInstalled(config);
  if (install && !install.ok) {
    return install;
  }

  const initial = await checkOpenJarvis(config);
  if (initial.ok || !config.openJarvisServeCommand) {
    return initial;
  }

  await launchDetachedShell(config.openJarvisServeCommand, config.rootDir);
  return waitForService(() => checkOpenJarvis(config));
};

export const checkOpenClaw = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.openClawEnabled) {
    return { ok: false, detail: 'disabled, but this package expects OpenClaw to be present' };
  }

  if (!config.openClawBaseUrl.trim()) {
    return { ok: false, detail: 'enabled, but OPENCLAW_BASE_URL is not configured' };
  }

  try {
    const response = await fetch(`${deriveRootUrl(config.openClawBaseUrl)}/healthz`, {
      headers: config.openClawApiKey
        ? { Authorization: `Bearer ${config.openClawApiKey}` }
        : {},
    });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    return { ok: true, detail: `reachable; model hint: ${config.openClawModel || 'not set'}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'OpenClaw unreachable' };
  }
};

export const ensureOpenClaw = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const install = await ensureOpenClawInstalled(config);
  if (install && !install.ok) {
    return install;
  }

  const initial = await checkOpenClaw(config);
  if (initial.ok || !config.openClawEnabled || !config.openClawStartCommand) {
    return initial;
  }

  await launchDetachedShell(config.openClawStartCommand, config.rootDir);
  return waitForService(() => checkOpenClaw(config));
};

export const checkN8n = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const status = await getN8nAccessStatus(config);
  return {
    ok: status.ok,
    detail: status.detail,
  };
};

export const ensureN8n = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const initial = await getN8nAccessStatus(config);
  if (!config.n8nEnabled) {
    return { ok: true, detail: 'disabled' };
  }

  if (initial.reachable) {
    if (initial.apiKeyReady || !config.n8nManagedByRepo || !initial.managedByRepo) {
      return {
        ok: initial.ok,
        detail: initial.detail,
      };
    }

    const access = await ensureN8nAutomationAccess(config);
    return {
      ok: access.ok,
      detail: access.detail,
    };
  }

  const launch = await runShellCommand(config.n8nStartCommand, config.rootDir);
  if (launch.code !== 0) {
    return {
      ok: false,
      detail: launch.stderr || launch.stdout || 'n8n start command failed',
    };
  }

  const reachable = await waitForN8nReachable(config);
  if (!reachable) {
    return {
      ok: false,
      detail: 'n8n start command returned, but the service did not become reachable in time',
    };
  }

  const access = await ensureN8nAutomationAccess(config);
  return {
    ok: access.ok,
    detail: access.detail,
  };
};

export const checkHermes = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.hermesEnabled) {
    return { ok: false, detail: 'disabled, but this package expects Hermes to be present' };
  }

  const exists = await commandExists(config.hermesCommand, config.rootDir);
  if (!exists) {
    return {
      ok: false,
      detail: `command not found: ${config.hermesCommand}`,
    };
  }

  if (config.hermesStatusArgs.length === 0) {
    return { ok: true, detail: `command available; model hint: ${config.hermesModelHint || 'not set'}` };
  }

  const result = await runCommand(config.hermesCommand, config.hermesStatusArgs, config.rootDir);
  if (result.code === 0) {
    return {
      ok: true,
      detail: `${result.stdout || 'command available'}; model hint: ${config.hermesModelHint || 'not set'}`,
    };
  }

  return {
    ok: false,
    detail: result.stderr || result.stdout || 'status command failed',
  };
};

export const ensureHermes = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const install = await ensureHermesInstalled(config);
  if (install && !install.ok) {
    return install;
  }

  const initial = await checkHermes(config);
  if (initial.ok || !config.hermesEnabled || !config.hermesStartCommand) {
    return initial;
  }

  await launchDetachedShell(config.hermesStartCommand, config.rootDir);
  return waitForService(() => checkHermes(config));
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
    return { ok: false, detail: 'disabled, but this package expects NemoClaw to be present' };
  }

  const exists = await commandExists(config.nemoClawCommand, config.rootDir);
  if (!exists) {
    return {
      ok: false,
      detail: `command not found: ${config.nemoClawCommand}`,
    };
  }

  if (config.nemoClawStatusArgs.length === 0) {
    return {
      ok: true,
      detail: `command available; provider: ${config.nemoClawProvider}; model: ${config.nemoClawModel}; sandbox: ${config.nemoClawSandboxName}`,
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

  const launcher = await ensureNemoClawLauncher(config);
  if (launcher && !launcher.ok) {
    return launcher;
  }

  return checkNemoClaw(config);
};
