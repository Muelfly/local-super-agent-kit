import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';
import { commandExists, launchDetachedShell, runCommand, runShellCommand } from './shell.js';
import { resolveConfiguredModelMatch, type ServiceStatus } from './lmStudio.js';
import { ensureN8nAutomationAccess, getN8nAccessStatus, waitForN8nReachable } from './n8n.js';

const buildModelsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/$/u, '')}/models`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const deriveRootUrl = (baseUrl: string): string => baseUrl.replace(/\/$/u, '').replace(/\/v1$/u, '');
const OPENCLAW_LMSTUDIO_PROVIDER = 'lmstudio';
const OPENCLAW_LMSTUDIO_API_KEY = 'lmstudio-local';

type OpenClawModelsStatus = {
  defaultModel?: string;
  resolvedDefault?: string;
  auth?: {
    missingProvidersInUse?: string[];
  };
};

type LaneModelResolution = {
  ok: boolean;
  detail: string;
  modelId?: string;
};

type HermesBinding = {
  defaultModel: string;
  provider: string;
  baseUrl: string;
};

type NemoClawSandboxEntry = {
  name?: string;
  provider?: string | null;
  model?: string | null;
};

type NemoClawRegistry = {
  sandboxes?: Record<string, NemoClawSandboxEntry>;
  defaultSandbox?: string | null;
};

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

export const buildOpenClawEnvironment = (config: RuntimeConfig): Record<string, string> => ({
  OPENCLAW_STATE_DIR: config.openClawStateDir,
  OPENCLAW_CONFIG_PATH: config.openClawConfigPath,
});

const quotePosixArg = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

const normalizeModelToken = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, '');

const isLikelyEmbeddingModel = (modelId: string): boolean => /embed|embedding/u.test(modelId.toLowerCase());

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/u, '');

const collectModelCandidates = (...groups: Array<string | string[] | undefined>): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) {
        continue;
      }

      const key = normalizeModelToken(trimmed);
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(trimmed);
    }
  }

  return merged;
};

const resolveOpenJarvisModelCandidates = (config: RuntimeConfig): string[] => {
  return collectModelCandidates(
    config.openJarvisModelHint,
    config.openJarvisModelCandidates,
    config.lmStudioModelHint,
    config.lmStudioModelCandidates,
  );
};

const resolveOpenClawModelCandidates = (config: RuntimeConfig): string[] => {
  return collectModelCandidates(
    config.openClawModel,
    config.openClawModelCandidates,
    config.lmStudioModelHint,
    config.lmStudioModelCandidates,
  );
};

const resolveHermesModelCandidates = (config: RuntimeConfig): string[] => {
  return collectModelCandidates(
    config.hermesModelHint,
    config.hermesModelCandidates,
    config.lmStudioModelHint,
    config.lmStudioModelCandidates,
  );
};

const resolveNemoClawModelCandidates = (config: RuntimeConfig): string[] => {
  return collectModelCandidates(
    config.nemoClawModel,
    config.nemoClawModelCandidates,
    config.lmStudioModelHint,
    config.lmStudioModelCandidates,
  );
};

const parseGatewayPort = (baseUrl: string, fallback = 18789): number => {
  try {
    const parsed = new URL(baseUrl);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : fallback;
  } catch {
    return fallback;
  }
};

const listLmStudioModels = async (config: RuntimeConfig): Promise<string[]> => {
  const response = await fetch(buildModelsUrl(config.lmStudioBaseUrl));
  if (!response.ok) {
    throw new Error(`LM Studio HTTP ${response.status}`);
  }

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return Array.isArray(payload.data)
    ? payload.data.map((item) => String(item.id ?? '').trim()).filter(Boolean)
    : [];
};

const resolveLaneModelFromLmStudio = async (
  config: RuntimeConfig,
  laneLabel: string,
  configuredCandidates: string[],
): Promise<LaneModelResolution> => {
  let models: string[] = [];

  try {
    models = await listLmStudioModels(config);
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'LM Studio model discovery failed',
    };
  }

  if (models.length === 0) {
    return {
      ok: false,
      detail: `LM Studio is reachable, but no model is loaded. Load a chat model before starting the packaged ${laneLabel} lane.`,
    };
  }

  const chatModels = models.filter((model) => !isLikelyEmbeddingModel(model));
  if (chatModels.length === 0) {
    return {
      ok: false,
      detail: `LM Studio only reports embedding-style models right now: ${models.join(', ')}`,
    };
  }

  const resolvedModel = resolveConfiguredModelMatch(chatModels, configuredCandidates);
  if (resolvedModel) {
    return {
      ok: true,
      detail: `matched configured LM Studio candidate set for ${laneLabel}`,
      modelId: resolvedModel,
    };
  }

  return {
    ok: false,
    detail: `Loaded LM Studio chat models did not match the packaged ${laneLabel} candidate set. Loaded: ${chatModels.join(', ')}. Candidates: ${configuredCandidates.join(', ') || 'none'}`,
  };
};

const resolveOpenClawModelFromLmStudio = async (config: RuntimeConfig): Promise<LaneModelResolution> => {
  return resolveLaneModelFromLmStudio(config, 'OpenClaw', resolveOpenClawModelCandidates(config));
};

const resolveHermesModelFromLmStudio = async (config: RuntimeConfig): Promise<LaneModelResolution> => {
  return resolveLaneModelFromLmStudio(config, 'Hermes', resolveHermesModelCandidates(config));
};

const resolveNemoClawModelFromLmStudio = async (config: RuntimeConfig): Promise<LaneModelResolution> => {
  return resolveLaneModelFromLmStudio(config, 'NemoClaw', resolveNemoClawModelCandidates(config));
};

const toWslPath = (windowsPath: string): string => {
  const normalized = path.resolve(windowsPath).replace(/\\/gu, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/u);
  if (!driveMatch) {
    return normalized;
  }

  const [, drive, remainder] = driveMatch;
  return `/mnt/${drive.toLowerCase()}/${remainder}`;
};

const resolveHermesLinuxCommand = async (config: RuntimeConfig): Promise<string | null> => {
  if (process.platform !== 'win32') {
    return null;
  }

  const wslHome = await resolveWslHome(config.rootDir);
  if (!wslHome) {
    return null;
  }

  return `${wslHome}/.hermes/hermes-agent/venv/bin/hermes`;
};

export const runHermesCommand = async (
  config: RuntimeConfig,
  args: string[],
  options: { timeoutMs?: number } = {},
) => {
  if (process.platform !== 'win32') {
    return runCommand(config.hermesCommand, args, config.rootDir, {
      HERMES_HOME: config.hermesHomeDir,
    }, options);
  }

  const linuxCommand = await resolveHermesLinuxCommand(config);
  if (!linuxCommand) {
    return {
      code: 1,
      stdout: '',
      stderr: 'could not resolve the Hermes Linux command path in WSL',
    };
  }

  const script = `HERMES_HOME=${quotePosixArg(toWslPath(config.hermesHomeDir))} ${quotePosixArg(linuxCommand)} ${args.map(quotePosixArg).join(' ')}`;
  return runCommand('wsl.exe', ['--', 'bash', '-lc', script], config.rootDir, {}, options);
};

const parseHermesBinding = (content: string): HermesBinding | null => {
  let inModelBlock = false;
  let defaultModel = '';
  let provider = '';
  let baseUrl = '';

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, '');
    if (/^model:\s*$/u.test(line)) {
      inModelBlock = true;
      continue;
    }

    if (!inModelBlock) {
      continue;
    }

    if (/^[^\s].*:\s*$/u.test(line)) {
      break;
    }

    const match = line.match(/^\s{2}([a-z_]+):\s*(.+)\s*$/u);
    if (!match) {
      continue;
    }

    const [, key, value] = match;
    const cleanedValue = value.trim().replace(/^['"]|['"]$/gu, '');
    if (key === 'default') {
      defaultModel = cleanedValue;
    } else if (key === 'provider') {
      provider = cleanedValue;
    } else if (key === 'base_url') {
      baseUrl = cleanedValue;
    }
  }

  if (!defaultModel && !provider && !baseUrl) {
    return null;
  }

  return {
    defaultModel,
    provider,
    baseUrl,
  };
};

const readHermesBinding = async (config: RuntimeConfig): Promise<{ ok: boolean; detail: string; binding?: HermesBinding }> => {
  const configPath = path.join(config.hermesHomeDir, 'config.yaml');
  if (!existsSync(configPath)) {
    return {
      ok: false,
      detail: `repo-local Hermes config is missing at ${configPath}`,
    };
  }

  try {
    const content = await readFile(configPath, 'utf8');
    const binding = parseHermesBinding(content);
    if (!binding) {
      return {
        ok: false,
        detail: `repo-local Hermes config at ${configPath} does not contain a readable model block`,
      };
    }
    return {
      ok: true,
      detail: 'ok',
      binding,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'could not read repo-local Hermes config',
    };
  }
};

const validateHermesLmStudioBinding = async (config: RuntimeConfig, expectedModelId: string): Promise<ServiceStatus> => {
  const result = await readHermesBinding(config);
  if (!result.ok || !result.binding) {
    return { ok: false, detail: result.detail };
  }

  const { binding } = result;
  if (binding.provider !== 'custom') {
    return {
      ok: false,
      detail: `repo-local Hermes provider mismatch: expected custom, got ${binding.provider || 'unset'}`,
    };
  }

  if (normalizeBaseUrl(binding.baseUrl) !== normalizeBaseUrl(config.lmStudioBaseUrl)) {
    return {
      ok: false,
      detail: `repo-local Hermes base_url mismatch: expected ${config.lmStudioBaseUrl}, got ${binding.baseUrl || 'unset'}`,
    };
  }

  if (binding.defaultModel !== expectedModelId) {
    return {
      ok: false,
      detail: `repo-local Hermes model mismatch: expected ${expectedModelId}, got ${binding.defaultModel || 'unset'}`,
    };
  }

  return {
    ok: true,
    detail: `repo-local LM Studio binding ready: ${binding.defaultModel}`,
  };
};

const ensureHermesLmStudioBinding = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const resolution = await resolveHermesModelFromLmStudio(config);
  if (!resolution.ok || !resolution.modelId) {
    return { ok: false, detail: resolution.detail };
  }

  await mkdir(config.hermesHomeDir, { recursive: true });
  for (const [key, value] of [
    ['model.default', resolution.modelId],
    ['model.provider', 'custom'],
    ['model.base_url', config.lmStudioBaseUrl],
  ] as Array<[string, string]>) {
    const result = await runHermesCommand(config, ['config', 'set', key, value]);
    if (result.code !== 0) {
      return {
        ok: false,
        detail: result.stderr || result.stdout || `Hermes config set failed for ${key}`,
      };
    }
  }

  return validateHermesLmStudioBinding(config, resolution.modelId);
};

const readNemoClawRegistry = async (config: RuntimeConfig): Promise<{ ok: boolean; detail: string; registry?: NemoClawRegistry }> => {
  if (process.platform === 'win32') {
    const result = await runCommand(
      'wsl.exe',
      ['--', 'bash', '-lc', 'if [ -f ~/.nemoclaw/sandboxes.json ]; then cat ~/.nemoclaw/sandboxes.json; else printf \'{"sandboxes":{},"defaultSandbox":null}\'; fi'],
      config.rootDir,
    );
    if (result.code !== 0) {
      return {
        ok: false,
        detail: result.stderr || result.stdout || 'could not read NemoClaw registry from WSL',
      };
    }

    try {
      return {
        ok: true,
        detail: 'ok',
        registry: JSON.parse(result.stdout) as NemoClawRegistry,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'could not parse NemoClaw registry',
      };
    }
  }

  const registryPath = path.join(process.env.HOME || '', '.nemoclaw', 'sandboxes.json');
  if (!existsSync(registryPath)) {
    return {
      ok: true,
      detail: 'ok',
      registry: { sandboxes: {}, defaultSandbox: null },
    };
  }

  try {
    return {
      ok: true,
      detail: 'ok',
      registry: JSON.parse(await readFile(registryPath, 'utf8')) as NemoClawRegistry,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'could not parse NemoClaw registry',
    };
  }
};

const validateNemoClawBinding = async (config: RuntimeConfig, expectedModelId: string): Promise<ServiceStatus> => {
  const registryResult = await readNemoClawRegistry(config);
  if (!registryResult.ok || !registryResult.registry) {
    return { ok: false, detail: registryResult.detail };
  }

  const sandboxes = registryResult.registry.sandboxes ?? {};
  const sandboxNames = Object.keys(sandboxes);
  if (sandboxNames.length === 0) {
    return {
      ok: false,
      detail: 'no NemoClaw sandboxes are registered yet',
    };
  }

  const activeName = registryResult.registry.defaultSandbox && sandboxes[registryResult.registry.defaultSandbox]
    ? registryResult.registry.defaultSandbox
    : sandboxNames[0];
  const entry = sandboxes[activeName];
  const provider = entry?.provider?.trim() || '';
  const model = entry?.model?.trim() || '';

  if (config.nemoClawProvider.trim() && provider !== config.nemoClawProvider.trim()) {
    return {
      ok: false,
      detail: `NemoClaw provider mismatch: expected ${config.nemoClawProvider}, got ${provider || 'unset'}`,
    };
  }

  if (!model) {
    return {
      ok: false,
      detail: `NemoClaw sandbox ${activeName} does not report a model yet`,
    };
  }

  if (model !== expectedModelId && normalizeModelToken(model) !== normalizeModelToken(expectedModelId)) {
    return {
      ok: false,
      detail: `NemoClaw model mismatch: expected ${expectedModelId}, got ${model}`,
    };
  }

  return {
    ok: true,
    detail: `default sandbox ${activeName}; provider: ${provider || 'unset'}; model: ${model}`,
  };
};

const writeManagedNemoClawSetupScript = async (config: RuntimeConfig, modelId: string): Promise<string> => {
  const scriptPath = path.join(config.rootDir, '.runtime', 'nemoclaw', 'setup.sh');
  const exportLines = [
    `export NON_INTERACTIVE=${quotePosixArg('1')}`,
    `export ACCEPT_THIRD_PARTY_SOFTWARE=${quotePosixArg('1')}`,
    `export NEMOCLAW_PROVIDER=${quotePosixArg(config.nemoClawProvider)}`,
    `export NEMOCLAW_MODEL=${quotePosixArg(modelId)}`,
    `export NEMOCLAW_SANDBOX_NAME=${quotePosixArg(config.nemoClawSandboxName)}`,
  ];

  if (config.nemoClawProvider.trim().toLowerCase() === 'custom') {
    exportLines.push(`export NEMOCLAW_ENDPOINT_URL=${quotePosixArg(config.nemoClawEndpointUrl)}`);
    exportLines.push(`export COMPATIBLE_API_KEY=${quotePosixArg(config.nemoClawCompatibleApiKey)}`);
  }

  const content = [
    '#!/usr/bin/env bash',
    'set -e',
    ...exportLines,
    'tmpfile=$(mktemp)',
    "trap 'rm -f \"$tmpfile\"' EXIT",
    'curl -fsSL https://www.nvidia.com/nemoclaw.sh -o "$tmpfile"',
    'bash "$tmpfile"',
  ].join('\n');

  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, content, 'utf8');
  return process.platform === 'win32' ? toWslPath(scriptPath) : scriptPath;
};

const runManagedNemoClawSetup = async (config: RuntimeConfig, modelId: string) => {
  const scriptPath = await writeManagedNemoClawSetupScript(config, modelId);

  if (process.platform === 'win32') {
    return runCommand('wsl.exe', ['--', 'bash', scriptPath], config.rootDir);
  }

  return runCommand('bash', [scriptPath], config.rootDir);
};

const readOpenClawModelsStatus = async (config: RuntimeConfig): Promise<{ ok: boolean; detail: string; status?: OpenClawModelsStatus }> => {
  const result = await runCommand(
    config.openClawCommand,
    ['models', 'status', '--json'],
    config.rootDir,
    buildOpenClawEnvironment(config),
  );

  if (result.code !== 0) {
    return {
      ok: false,
      detail: result.stderr || result.stdout || 'openclaw models status failed',
    };
  }

  try {
    return {
      ok: true,
      detail: 'ok',
      status: JSON.parse(result.stdout) as OpenClawModelsStatus,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'could not parse OpenClaw model status',
    };
  }
};

const validateOpenClawLmStudioBinding = async (config: RuntimeConfig, expectedModelId: string): Promise<ServiceStatus> => {
  if (!existsSync(config.openClawConfigPath)) {
    return {
      ok: false,
      detail: `repo-local OpenClaw config is missing at ${config.openClawConfigPath}; rerun bootstrap to bind LM Studio`,
    };
  }

  const statusResult = await readOpenClawModelsStatus(config);
  if (!statusResult.ok || !statusResult.status) {
    return { ok: false, detail: statusResult.detail };
  }

  const expected = `${OPENCLAW_LMSTUDIO_PROVIDER}/${expectedModelId}`;
  const resolved = statusResult.status.resolvedDefault?.trim() || statusResult.status.defaultModel?.trim() || '';
  if (resolved !== expected) {
    return {
      ok: false,
      detail: `repo-local OpenClaw binding mismatch: expected ${expected}, got ${resolved || 'unset'}`,
    };
  }

  const missingProviders = statusResult.status.auth?.missingProvidersInUse ?? [];
  if (missingProviders.includes(OPENCLAW_LMSTUDIO_PROVIDER)) {
    return {
      ok: false,
      detail: 'repo-local OpenClaw binding still reports missing LM Studio provider auth',
    };
  }

  return {
    ok: true,
    detail: `repo-local LM Studio binding ready: ${expected}`,
  };
};

const ensureOpenClawLmStudioBinding = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const resolution = await resolveOpenClawModelFromLmStudio(config);
  if (!resolution.ok || !resolution.modelId) {
    return { ok: false, detail: resolution.detail };
  }

  await mkdir(config.openClawStateDir, { recursive: true });
  const onboarding = await runCommand(
    config.openClawCommand,
    [
      'onboard',
      '--non-interactive',
      '--accept-risk',
      '--mode',
      'local',
      '--auth-choice',
      'custom-api-key',
      '--custom-provider-id',
      OPENCLAW_LMSTUDIO_PROVIDER,
      '--custom-base-url',
      config.lmStudioBaseUrl,
      '--custom-compatibility',
      'openai',
      '--custom-model-id',
      resolution.modelId,
      '--custom-api-key',
      OPENCLAW_LMSTUDIO_API_KEY,
      '--workspace',
      config.openClawWorkspaceDir,
      '--gateway-bind',
      'loopback',
      '--gateway-port',
      String(parseGatewayPort(config.openClawBaseUrl)),
      '--skip-channels',
      '--skip-daemon',
      '--json',
    ],
    config.rootDir,
    buildOpenClawEnvironment(config),
  );

  if (onboarding.code !== 0) {
    return {
      ok: false,
      detail: onboarding.stderr || onboarding.stdout || 'OpenClaw LM Studio onboarding failed',
    };
  }

  return validateOpenClawLmStudioBinding(config, resolution.modelId);
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
    const configuredCandidates = resolveOpenJarvisModelCandidates(config);
    const matchedModel = resolveConfiguredModelMatch(models, configuredCandidates);
    if (!matchedModel) {
      return {
        ok: false,
        detail: `OpenJarvis models did not match the packaged target. Loaded: ${models.join(', ') || 'none'}. Candidates: ${configuredCandidates.join(', ') || 'none'}`,
      };
    }
    const evalHook = config.openJarvisEvalCommand ? 'eval hook configured' : 'eval hook not configured';
    const modelDetail = models.length > 0 ? `models: ${models.join(', ')}` : 'no models listed';
    return { ok: true, detail: `${modelDetail}; matched packaged target: ${matchedModel}; ${evalHook}` };
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

  const resolution = await resolveOpenClawModelFromLmStudio(config);
  if (!resolution.ok || !resolution.modelId) {
    return { ok: false, detail: resolution.detail };
  }

  const binding = await validateOpenClawLmStudioBinding(config, resolution.modelId);
  if (!binding.ok) {
    return binding;
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
    return {
      ok: true,
      detail: `gateway/control reachable; ${binding.detail}; LM Studio target: ${resolution.modelId}`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'OpenClaw unreachable' };
  }
};

export const ensureOpenClaw = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const install = await ensureOpenClawInstalled(config);
  if (install && !install.ok) {
    return install;
  }

  const binding = await ensureOpenClawLmStudioBinding(config);
  if (!binding.ok) {
    return binding;
  }

  const initial = await checkOpenClaw(config);
  if (initial.ok || !config.openClawEnabled || !config.openClawStartCommand) {
    return initial;
  }

  await launchDetachedShell(config.openClawStartCommand, config.rootDir, buildOpenClawEnvironment(config));
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

  const launch = await runShellCommand(config.n8nStartCommand, config.rootDir, {
    N8N_HOST_PORT: String(config.n8nHostPort),
  });
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

  const resolution = await resolveHermesModelFromLmStudio(config);
  if (!resolution.ok || !resolution.modelId) {
    return { ok: false, detail: resolution.detail };
  }

  const binding = await validateHermesLmStudioBinding(config, resolution.modelId);
  if (!binding.ok) {
    return binding;
  }

  return { ok: true, detail: `${binding.detail}; LM Studio target: ${resolution.modelId}` };
};

export const ensureHermes = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const install = await ensureHermesInstalled(config);
  if (install && !install.ok) {
    return install;
  }

  const binding = await ensureHermesLmStudioBinding(config);
  if (!binding.ok) {
    return binding;
  }

  const initial = await checkHermes(config);
  if (initial.ok || !config.hermesEnabled || !config.hermesStartCommand) {
    return initial;
  }

  await launchDetachedShell(config.hermesStartCommand, config.rootDir, {
    HERMES_HOME: config.hermesHomeDir,
  });
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

  const resolution = await resolveNemoClawModelFromLmStudio(config);
  if (!resolution.ok || !resolution.modelId) {
    return { ok: false, detail: resolution.detail };
  }

  const binding = await validateNemoClawBinding(config, resolution.modelId);
  if (!binding.ok) {
    return binding;
  }

  if (config.nemoClawStatusArgs.length === 0) {
    return {
      ok: true,
      detail: binding.detail,
    };
  }

  const result = await runCommand(config.nemoClawCommand, config.nemoClawStatusArgs, config.rootDir);
  if (result.code === 0) {
    return { ok: true, detail: `${binding.detail}; ${result.stdout || 'installed'}` };
  }

  return { ok: false, detail: result.stderr || result.stdout || 'status command failed' };
};

export const ensureNemoClaw = async (config: RuntimeConfig): Promise<ServiceStatus> => {
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

  const initial = await checkNemoClaw(config);
  if (initial.ok || !config.nemoClawSetupCommand) {
    return initial;
  }

  const resolution = await resolveNemoClawModelFromLmStudio(config);
  if (!resolution.ok || !resolution.modelId) {
    return { ok: false, detail: resolution.detail };
  }

  const setup = config.nemoClawProvider.trim().toLowerCase() === 'custom'
    ? await runManagedNemoClawSetup(config, resolution.modelId)
    : await runShellCommand(config.nemoClawSetupCommand, config.rootDir);
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
