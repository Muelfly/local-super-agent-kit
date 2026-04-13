import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ProfileName = '4060ti-8b' | '3060ti-30b';

const PROFILE_PATHS: Record<ProfileName, string> = {
  '4060ti-8b': path.join('config', 'profiles', '4060ti-8b.env'),
  '3060ti-30b': path.join('config', 'profiles', '3060ti-30b.env'),
};

export type RuntimeConfig = {
  rootDir: string;
  lmStudioBaseUrl: string;
  lmStudioAppPath: string;
  lmStudioAutoLaunch: boolean;
  lmStudioHealthTimeoutMs: number;
  lmStudioModelHint: string;
  lmStudioModelCandidates: string[];
  lmStudioAutoAcquireModels: boolean;
  lmStudioAutoLoadPrimaryModel: boolean;
  lmStudioProfile: string;
  openJarvisEnabled: boolean;
  openJarvisCommand: string;
  openJarvisBaseUrl: string;
  openJarvisApiKey: string;
  openJarvisStatusArgs: string[];
  openJarvisServeCommand: string;
  openJarvisModelHint: string;
  openJarvisModelCandidates: string[];
  openClawEnabled: boolean;
  openClawCommand: string;
  openClawBaseUrl: string;
  openClawApiKey: string;
  openClawModel: string;
  openClawModelCandidates: string[];
  openClawStateDir: string;
  openClawConfigPath: string;
  openClawWorkspaceDir: string;
  openClawStatusArgs: string[];
  openClawInstallCommand: string;
  openClawStartCommand: string;
  nemoClawEnabled: boolean;
  nemoClawCommand: string;
  nemoClawStatusArgs: string[];
  nemoClawSetupCommand: string;
  nemoClawProvider: string;
  nemoClawModel: string;
  nemoClawModelCandidates: string[];
  nemoClawEndpointUrl: string;
  nemoClawCompatibleApiKey: string;
  nemoClawSandboxName: string;
  hermesEnabled: boolean;
  hermesCommand: string;
  hermesInstallCommand: string;
  hermesStatusArgs: string[];
  hermesStartCommand: string;
  hermesModelHint: string;
  hermesModelCandidates: string[];
  hermesHomeDir: string;
  nvidiaApiKey: string;
  n8nEnabled: boolean;
  n8nHostPort: number;
  n8nBaseUrl: string;
  n8nStartCommand: string;
  n8nToolSurfaceFile: string;
  n8nGeneratedSurfaceFile: string;
  n8nPromoteCommand: string;
  n8nManagedByRepo: boolean;
  n8nApiKey: string;
  n8nOwnerEmail: string;
  n8nOwnerPassword: string;
  controlPlaneEnabled: boolean;
  controlPlaneHost: string;
  controlPlanePort: number;
  controlPlaneBaseUrl: string;
  controlPlaneStartCommand: string;
  runtimeStateDir: string;
  chatSdkEnabled: boolean;
  chatSdkAdapters: string[];
  chatSdkUserName: string;
  chatSdkLedgerDir: string;
  sharedMcpEnabled: boolean;
  sharedMcpUrl: string;
  openJarvisEvalCommand: string;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const parseInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseStringList = (value: string | undefined): string[] => {
  if (value === undefined || value.trim() === '') {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const mergeUniqueStrings = (...groups: Array<string[] | undefined>): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const group of groups) {
    for (const value of group ?? []) {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }

      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(trimmed);
    }
  }

  return merged;
};

const quoteShellValue = (value: string): string => {
  if (!value || !/[\s"]/u.test(value)) {
    return value;
  }

  if (process.platform === 'win32') {
    return `"${value.replace(/"/gu, '""')}"`;
  }

  return `'${value.replace(/'/gu, `'\\''`)}'`;
};

const defaultOpenClawCommand = (): string => {
  if (process.platform !== 'win32') {
    return 'openclaw';
  }

  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'npm', 'openclaw.cmd');
};

const defaultHermesCommand = (): string => {
  if (process.platform !== 'win32') {
    return 'hermes';
  }

  return path.join(process.env.USERPROFILE || '', 'bin', 'hermes.cmd');
};

const defaultHermesInstallCommand = (): string => {
  if (process.platform === 'win32') {
    return 'wsl.exe -- bash -lc "mkdir -p ~/.hermes/hermes-agent && python3 -m venv ~/.hermes/hermes-agent/venv && ~/.hermes/hermes-agent/venv/bin/python -m ensurepip --upgrade && ~/.hermes/hermes-agent/venv/bin/python -m pip install --upgrade pip && ~/.hermes/hermes-agent/venv/bin/python -m pip install \'hermes-agent[cli,pty,mcp,acp,cron]\'"';
  }

  return "mkdir -p ~/.hermes/hermes-agent && python3 -m venv ~/.hermes/hermes-agent/venv && ~/.hermes/hermes-agent/venv/bin/python -m ensurepip --upgrade && ~/.hermes/hermes-agent/venv/bin/python -m pip install --upgrade pip && ~/.hermes/hermes-agent/venv/bin/python -m pip install 'hermes-agent[cli,pty,mcp,acp,cron]' && mkdir -p ~/.local/bin && ln -sf ~/.hermes/hermes-agent/venv/bin/hermes ~/.local/bin/hermes";
};

const quotePosixValue = (value: string): string => {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
};

const resolveRuntimeBinDir = (rootDir: string): string => {
  return path.join(rootDir, '.runtime', 'bin');
};

const defaultOpenJarvisCommand = (rootDir: string): string => {
  const binDir = resolveRuntimeBinDir(rootDir);
  return path.join(binDir, process.platform === 'win32' ? 'jarvis.cmd' : 'jarvis');
};

const defaultNemoClawCommand = (rootDir: string): string => {
  const binDir = resolveRuntimeBinDir(rootDir);
  return path.join(binDir, process.platform === 'win32' ? 'nemoclaw.cmd' : 'nemoclaw');
};

const parseServiceBinding = (baseUrl: string, fallbackPort: number): { host: string; port: number } => {
  try {
    const parsed = new URL(baseUrl);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? Number(parsed.port) || fallbackPort : fallbackPort,
    };
  } catch {
    return {
      host: '127.0.0.1',
      port: fallbackPort,
    };
  }
};

const defaultOpenJarvisServeCommand = (command: string, baseUrl: string, modelHint: string): string => {
  const binding = parseServiceBinding(baseUrl, 8000);
  const args = [
    `${quoteShellValue(command)} start`,
    `--host ${quoteShellValue(binding.host)}`,
    `--port ${binding.port}`,
    '-e lmstudio',
  ];

  if (modelHint.trim()) {
    args.push(`-m ${quoteShellValue(modelHint.trim())}`);
  }

  return args.join(' ');
};

const defaultNemoClawSetupCommand = (
  provider: string,
  model: string,
  sandboxName: string,
  endpointUrl: string,
  compatibleApiKey: string,
): string => {
  const envAssignments = [
    'NON_INTERACTIVE=1',
    'ACCEPT_THIRD_PARTY_SOFTWARE=1',
    `NEMOCLAW_PROVIDER=${quotePosixValue(provider)}`,
    `NEMOCLAW_MODEL=${quotePosixValue(model)}`,
    `NEMOCLAW_SANDBOX_NAME=${quotePosixValue(sandboxName)}`,
  ];

  if (provider.trim().toLowerCase() === 'custom') {
    if (endpointUrl.trim()) {
      envAssignments.push(`NEMOCLAW_ENDPOINT_URL=${quotePosixValue(endpointUrl)}`);
    }
    if (compatibleApiKey.trim()) {
      envAssignments.push(`COMPATIBLE_API_KEY=${quotePosixValue(compatibleApiKey)}`);
    }
  }

  const linuxCommand = [
    'set -e',
    'tmpfile=$(mktemp)',
    'curl -fsSL https://www.nvidia.com/nemoclaw.sh -o "$tmpfile"',
    [...envAssignments, 'bash "$tmpfile"'].join(' '),
    'rm -f "$tmpfile"',
  ].join('; ');

  if (process.platform === 'win32') {
    return `wsl.exe -- bash -lc ${quoteShellValue(linuxCommand)}`;
  }

  return linuxCommand;
};

const parseEnvText = (content: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    if (index < 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) {
      map.set(key, value);
    }
  }
  return map;
};

const readEnvMap = async (filePath: string): Promise<Map<string, string>> => {
  if (!existsSync(filePath)) {
    return new Map<string, string>();
  }
  const content = await readFile(filePath, 'utf8');
  return parseEnvText(content);
};

const serializeEnvMap = (entries: Map<string, string>): string => {
  const lines: string[] = [];
  for (const [key, value] of entries.entries()) {
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
};

export const resolveProfilePath = (rootDir: string, profile: ProfileName): string => {
  return path.join(rootDir, PROFILE_PATHS[profile]);
};

export const applyProfile = async (rootDir: string, profile: ProfileName): Promise<string> => {
  return applyProfileWithOverrides(rootDir, profile);
};

export const applyProfileWithOverrides = async (
  rootDir: string,
  profile: ProfileName,
  overrides: Record<string, string> = {},
): Promise<string> => {
  const basePath = path.join(rootDir, '.env.example');
  const targetPath = path.join(rootDir, '.env.local');
  const profilePath = resolveProfilePath(rootDir, profile);
  const base = await readEnvMap(basePath);
  const overlay = await readEnvMap(profilePath);

  for (const [key, value] of overlay.entries()) {
    base.set(key, value);
  }

  for (const [key, value] of Object.entries(overrides)) {
    base.set(key, value);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, serializeEnvMap(base), 'utf8');
  return targetPath;
};

const mergedEnv = async (rootDir: string): Promise<Map<string, string>> => {
  const base = await readEnvMap(path.join(rootDir, '.env.example'));
  const repoEnv = await readEnvMap(path.join(rootDir, '.env'));
  const localEnv = await readEnvMap(path.join(rootDir, '.env.local'));

  for (const source of [repoEnv, localEnv]) {
    for (const [key, value] of source.entries()) {
      base.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value !== '') {
      base.set(key, value);
    }
  }

  return base;
};

export const loadRuntimeConfig = async (rootDir: string): Promise<RuntimeConfig> => {
  const env = await mergedEnv(rootDir);
  const get = (key: string, fallback = ''): string => {
    const value = env.get(key);
    return value === undefined || value.trim() === '' ? fallback : value;
  };
  const runtimeStateDir = get('RUNTIME_STATE_DIR', '.runtime');
  const controlPlaneHost = get('CONTROL_PLANE_HOST', '127.0.0.1');
  const controlPlanePort = parseInteger(get('CONTROL_PLANE_PORT'), 4391);
  const controlPlaneBaseUrl = get('CONTROL_PLANE_BASE_URL', `http://${controlPlaneHost}:${controlPlanePort}`);
  const lmStudioBaseUrl = get('LM_STUDIO_BASE_URL', 'http://127.0.0.1:1234/v1');
  const lmStudioModelHint = get('LM_STUDIO_MODEL_HINT', 'nemotron-nano-8b');
  const lmStudioModelCandidates = mergeUniqueStrings(parseStringList(get('LM_STUDIO_MODEL_CANDIDATES')), [lmStudioModelHint]);
  const openJarvisCommand = get('OPENJARVIS_COMMAND', defaultOpenJarvisCommand(rootDir));
  const openJarvisBaseUrl = get('OPENJARVIS_BASE_URL', 'http://127.0.0.1:8000/v1');
  const openJarvisModelHint = get('OPENJARVIS_MODEL_HINT', lmStudioModelHint);
  const openJarvisModelCandidates = mergeUniqueStrings(
    parseStringList(get('OPENJARVIS_MODEL_CANDIDATES')),
    [openJarvisModelHint],
    lmStudioModelCandidates,
  );
  const openClawCommand = get('OPENCLAW_COMMAND', defaultOpenClawCommand());
  const openClawBaseUrl = get('OPENCLAW_BASE_URL', 'http://127.0.0.1:18789/v1');
  const openClawBinding = parseServiceBinding(openClawBaseUrl, 18789);
  const openClawStateDir = get('OPENCLAW_STATE_DIR', path.join(rootDir, runtimeStateDir, 'openclaw'));
  const openClawConfigPath = get('OPENCLAW_CONFIG_PATH', path.join(openClawStateDir, 'openclaw.json'));
  const openClawWorkspaceDir = get('OPENCLAW_WORKSPACE_DIR', rootDir);
  const openClawModel = get('OPENCLAW_MODEL', lmStudioModelHint);
  const openClawModelCandidates = mergeUniqueStrings(
    parseStringList(get('OPENCLAW_MODEL_CANDIDATES')),
    [openClawModel],
    lmStudioModelCandidates,
  );
  const nemoClawCommand = get('NEMOCLAW_COMMAND', defaultNemoClawCommand(rootDir));
  const nemoClawProvider = get('NEMOCLAW_PROVIDER', 'custom');
  const nemoClawModel = get('NEMOCLAW_MODEL', lmStudioModelHint);
  const nemoClawModelCandidates = mergeUniqueStrings(
    parseStringList(get('NEMOCLAW_MODEL_CANDIDATES')),
    [nemoClawModel],
    lmStudioModelCandidates,
  );
  const nemoClawEndpointUrl = get('NEMOCLAW_ENDPOINT_URL', lmStudioBaseUrl);
  const nemoClawCompatibleApiKey = get('NEMOCLAW_COMPATIBLE_API_KEY', 'lmstudio-local');
  const nemoClawSandboxName = get('NEMOCLAW_SANDBOX_NAME', 'local-super-agent');
  const hermesCommand = get('HERMES_COMMAND', defaultHermesCommand());
  const hermesModelHint = get('HERMES_MODEL_HINT', lmStudioModelHint);
  const hermesModelCandidates = mergeUniqueStrings(
    parseStringList(get('HERMES_MODEL_CANDIDATES')),
    [hermesModelHint],
    lmStudioModelCandidates,
  );
  const hermesHomeDir = get('HERMES_HOME_DIR', path.join(rootDir, runtimeStateDir, 'hermes'));

  return {
    rootDir,
    lmStudioBaseUrl,
    lmStudioAppPath: get('LM_STUDIO_APP_PATH'),
    lmStudioAutoLaunch: parseBoolean(get('LM_STUDIO_AUTO_LAUNCH'), true),
    lmStudioHealthTimeoutMs: parseInteger(get('LM_STUDIO_HEALTH_TIMEOUT_MS'), 45_000),
    lmStudioModelHint,
    lmStudioModelCandidates,
    lmStudioAutoAcquireModels: parseBoolean(get('LM_STUDIO_AUTO_ACQUIRE_MODELS'), false),
    lmStudioAutoLoadPrimaryModel: parseBoolean(get('LM_STUDIO_AUTO_LOAD_PRIMARY_MODEL'), false),
    lmStudioProfile: get('LM_STUDIO_PROFILE', '4060ti-8b'),
    openJarvisEnabled: parseBoolean(get('OPENJARVIS_ENABLED'), true),
    openJarvisCommand,
    openJarvisBaseUrl,
    openJarvisApiKey: get('OPENJARVIS_API_KEY'),
    openJarvisStatusArgs: get('OPENJARVIS_STATUS_ARGS', 'status').split(' ').map((item) => item.trim()).filter(Boolean),
    openJarvisServeCommand: get('OPENJARVIS_SERVE_COMMAND', defaultOpenJarvisServeCommand(openJarvisCommand, openJarvisBaseUrl, openJarvisModelHint)),
    openJarvisModelHint,
    openJarvisModelCandidates,
    openClawEnabled: parseBoolean(get('OPENCLAW_ENABLED'), true),
    openClawCommand,
    openClawBaseUrl,
    openClawApiKey: get('OPENCLAW_API_KEY'),
    openClawModel,
    openClawModelCandidates,
    openClawStateDir,
    openClawConfigPath,
    openClawWorkspaceDir,
    openClawStatusArgs: get('OPENCLAW_STATUS_ARGS', 'gateway status').split(' ').map((item) => item.trim()).filter(Boolean),
    openClawInstallCommand: get('OPENCLAW_INSTALL_COMMAND', 'npm install -g openclaw@latest'),
    openClawStartCommand: get('OPENCLAW_START_COMMAND', `${quoteShellValue(openClawCommand)} gateway run --allow-unconfigured --bind loopback --auth none --port ${openClawBinding.port} --force --verbose`),
    nemoClawEnabled: parseBoolean(get('NEMOCLAW_ENABLED'), true),
    nemoClawCommand,
    nemoClawStatusArgs: get('NEMOCLAW_STATUS_ARGS', 'status').split(' ').map((item) => item.trim()).filter(Boolean),
    nemoClawSetupCommand: get('NEMOCLAW_SETUP_COMMAND', defaultNemoClawSetupCommand(nemoClawProvider, nemoClawModel, nemoClawSandboxName, nemoClawEndpointUrl, nemoClawCompatibleApiKey)),
    nemoClawProvider,
    nemoClawModel,
    nemoClawModelCandidates,
    nemoClawEndpointUrl,
    nemoClawCompatibleApiKey,
    nemoClawSandboxName,
    hermesEnabled: parseBoolean(get('HERMES_ENABLED'), true),
    hermesCommand,
    hermesInstallCommand: get('HERMES_INSTALL_COMMAND', defaultHermesInstallCommand()),
    hermesStatusArgs: get('HERMES_STATUS_ARGS', 'status --all').split(' ').map((item) => item.trim()).filter(Boolean),
    hermesStartCommand: get('HERMES_START_COMMAND'),
    hermesModelHint,
    hermesModelCandidates,
    hermesHomeDir,
    nvidiaApiKey: get('NVIDIA_API_KEY'),
    n8nEnabled: parseBoolean(get('N8N_ENABLED'), true),
    n8nHostPort: parseInteger(get('N8N_HOST_PORT'), 5679),
    n8nBaseUrl: get('N8N_BASE_URL', `http://127.0.0.1:${parseInteger(get('N8N_HOST_PORT'), 5679)}`),
    n8nStartCommand: get('N8N_START_COMMAND', 'docker compose -f compose.local.yml up -d n8n'),
    n8nToolSurfaceFile: get('N8N_TOOL_SURFACE_FILE', 'config/tools/default-surface.json'),
    n8nGeneratedSurfaceFile: get('N8N_GENERATED_SURFACE_FILE', 'generated/tool-surface.generated.json'),
    n8nPromoteCommand: get('N8N_PROMOTE_COMMAND'),
    n8nManagedByRepo: parseBoolean(get('N8N_MANAGED_BY_REPO'), true),
    n8nApiKey: get('N8N_API_KEY'),
    n8nOwnerEmail: get('N8N_OWNER_EMAIL'),
    n8nOwnerPassword: get('N8N_OWNER_PASSWORD'),
    controlPlaneEnabled: parseBoolean(get('CONTROL_PLANE_ENABLED'), true),
    controlPlaneHost,
    controlPlanePort,
    controlPlaneBaseUrl,
    controlPlaneStartCommand: get('CONTROL_PLANE_START_COMMAND', 'node --import tsx src/cli.ts serve-control-plane'),
    runtimeStateDir,
    chatSdkEnabled: parseBoolean(get('CHAT_SDK_ENABLED'), false),
    chatSdkAdapters: get('CHAT_SDK_ADAPTERS', 'discord,github').split(',').map((item) => item.trim()).filter(Boolean),
    chatSdkUserName: get('CHAT_SDK_USER_NAME', 'local-super-agent'),
    chatSdkLedgerDir: get('CHAT_SDK_LEDGER_DIR', path.join(runtimeStateDir, 'chat-sdk')),
    sharedMcpEnabled: parseBoolean(get('SHARED_MCP_ENABLED'), false),
    sharedMcpUrl: get('SHARED_MCP_URL'),
    openJarvisEvalCommand: get('OPENJARVIS_EVAL_COMMAND'),
  };
};
