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
  lmStudioProfile: string;
  openJarvisEnabled: boolean;
  openJarvisBaseUrl: string;
  openJarvisApiKey: string;
  openJarvisServeCommand: string;
  nemoClawEnabled: boolean;
  nemoClawCommand: string;
  nemoClawStatusArgs: string[];
  nemoClawSetupCommand: string;
  nemoClawProvider: string;
  nemoClawModel: string;
  nemoClawSandboxName: string;
  nvidiaApiKey: string;
  n8nEnabled: boolean;
  n8nBaseUrl: string;
  n8nStartCommand: string;
  n8nToolSurfaceFile: string;
  chatSdkEnabled: boolean;
  chatSdkAdapters: string[];
  chatSdkUserName: string;
  sharedMcpEnabled: boolean;
  sharedMcpUrl: string;
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
  const basePath = path.join(rootDir, '.env.example');
  const targetPath = path.join(rootDir, '.env.local');
  const profilePath = resolveProfilePath(rootDir, profile);
  const base = await readEnvMap(basePath);
  const overlay = await readEnvMap(profilePath);

  for (const [key, value] of overlay.entries()) {
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
  const get = (key: string, fallback = ''): string => env.get(key) ?? fallback;

  return {
    rootDir,
    lmStudioBaseUrl: get('LM_STUDIO_BASE_URL', 'http://127.0.0.1:1234/v1'),
    lmStudioAppPath: get('LM_STUDIO_APP_PATH'),
    lmStudioAutoLaunch: parseBoolean(get('LM_STUDIO_AUTO_LAUNCH'), true),
    lmStudioHealthTimeoutMs: parseInteger(get('LM_STUDIO_HEALTH_TIMEOUT_MS'), 45_000),
    lmStudioModelHint: get('LM_STUDIO_MODEL_HINT', 'nemotron-nano-8b'),
    lmStudioProfile: get('LM_STUDIO_PROFILE', '4060ti-8b'),
    openJarvisEnabled: parseBoolean(get('OPENJARVIS_ENABLED'), true),
    openJarvisBaseUrl: get('OPENJARVIS_BASE_URL', 'http://127.0.0.1:8000/v1'),
    openJarvisApiKey: get('OPENJARVIS_API_KEY'),
    openJarvisServeCommand: get('OPENJARVIS_SERVE_COMMAND'),
    nemoClawEnabled: parseBoolean(get('NEMOCLAW_ENABLED'), false),
    nemoClawCommand: get('NEMOCLAW_COMMAND', 'nemoclaw'),
    nemoClawStatusArgs: get('NEMOCLAW_STATUS_ARGS', 'status').split(' ').map((item) => item.trim()).filter(Boolean),
    nemoClawSetupCommand: get('NEMOCLAW_SETUP_COMMAND'),
    nemoClawProvider: get('NEMOCLAW_PROVIDER', 'lmstudio'),
    nemoClawModel: get('NEMOCLAW_MODEL', 'nemotron-nano-8b'),
    nemoClawSandboxName: get('NEMOCLAW_SANDBOX_NAME', 'local-super-agent'),
    nvidiaApiKey: get('NVIDIA_API_KEY'),
    n8nEnabled: parseBoolean(get('N8N_ENABLED'), true),
    n8nBaseUrl: get('N8N_BASE_URL', 'http://127.0.0.1:5678'),
    n8nStartCommand: get('N8N_START_COMMAND', 'docker compose -f compose.local.yml up -d n8n'),
    n8nToolSurfaceFile: get('N8N_TOOL_SURFACE_FILE', 'config/tools/default-surface.json'),
    chatSdkEnabled: parseBoolean(get('CHAT_SDK_ENABLED'), false),
    chatSdkAdapters: get('CHAT_SDK_ADAPTERS', 'discord,github').split(',').map((item) => item.trim()).filter(Boolean),
    chatSdkUserName: get('CHAT_SDK_USER_NAME', 'local-super-agent'),
    sharedMcpEnabled: parseBoolean(get('SHARED_MCP_ENABLED'), false),
    sharedMcpUrl: get('SHARED_MCP_URL'),
  };
};
