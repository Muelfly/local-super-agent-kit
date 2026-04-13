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

const MAX_AUTO_MODEL_CANDIDATES = 3;
const LM_STUDIO_LOAD_IDENTIFIER = 'local-super-agent';
const MODEL_BUNDLE_WAIT_ATTEMPTS = 30;
const MODEL_BUNDLE_WAIT_DELAY_MS = 2_000;

type LmStudioListedModel = {
  type?: string;
  modelKey?: string;
  displayName?: string;
  path?: string;
  indexedModelIdentifier?: string;
};

type LmStudioAcquireAlias = {
  aliases: string[];
  acquireCandidates: string[];
};

const LM_STUDIO_ACQUIRE_ALIASES: LmStudioAcquireAlias[] = [
  {
    aliases: [
      'nemotron-nano-8b',
      'llama-3.1-nemotron-nano-8b-v1',
      'nvidia_llama-3.1-nemotron-nano-8b-v1',
      'nvidia/llama-3.1-nemotron-nano-8b-v1',
      'hf.co/bartowski/nvidia_Llama-3.1-Nemotron-Nano-8B-v1-GGUF',
    ],
    acquireCandidates: [
      'https://huggingface.co/bartowski/nvidia_Llama-3.1-Nemotron-Nano-8B-v1-GGUF',
    ],
  },
  {
    aliases: [
      'nemotron-3-nano-30b',
      'nemotron-3-nano-30b-a3b',
      'nvidia-nemotron-3-nano-30b-a3b',
      'unsloth/nemotron-3-nano-30b-a3b-gguf',
    ],
    acquireCandidates: [
      'https://huggingface.co/unsloth/Nemotron-3-Nano-30B-A3B-GGUF',
    ],
  },
];

const normalizeModelToken = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, '');

const splitModelTokens = (value: string): string[] => {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !['gguf', 'hf', 'co', 'model'].includes(token));
};

const dedupeCandidates = (values: string[]): string[] => {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};

const matchesConfiguredCandidate = (availableValue: string, candidate: string): boolean => {
  const normalizedAvailable = normalizeModelToken(availableValue);
  const normalizedCandidate = normalizeModelToken(candidate);
  if (!normalizedAvailable || !normalizedCandidate) {
    return false;
  }

  if (normalizedAvailable === normalizedCandidate) {
    return true;
  }

  if (normalizedAvailable.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedAvailable)) {
    return true;
  }

  const candidateTokens = splitModelTokens(candidate);
  return candidateTokens.length > 0 && candidateTokens.every((token) => normalizedAvailable.includes(normalizeModelToken(token)));
};

const findAcquireAlias = (candidate: string): LmStudioAcquireAlias | undefined => {
  return LM_STUDIO_ACQUIRE_ALIASES.find((alias) => {
    return alias.aliases.some((item) => matchesConfiguredCandidate(item, candidate) || matchesConfiguredCandidate(candidate, item));
  });
};

const expandMatchCandidates = (candidates: string[]): string[] => {
  const expanded: string[] = [];
  for (const candidate of dedupeCandidates(candidates)) {
    expanded.push(candidate);
    const alias = findAcquireAlias(candidate);
    if (alias) {
      expanded.push(...alias.aliases);
    }
  }
  return dedupeCandidates(expanded);
};

const expandAcquireCandidates = (candidates: string[]): string[] => {
  const expanded: string[] = [];
  for (const candidate of dedupeCandidates(candidates)) {
    const alias = findAcquireAlias(candidate);
    if (alias) {
      expanded.push(...alias.acquireCandidates);
    }
    expanded.push(candidate);
  }
  return dedupeCandidates(expanded);
};

export const resolveConfiguredModelMatch = (models: string[], candidates: string[]): string | null => {
  for (const candidate of expandMatchCandidates(candidates)) {
    const match = models.find((model) => matchesConfiguredCandidate(model, candidate));
    if (match) {
      return match;
    }
  }

  return null;
};

const isLikelyEmbeddingModel = (modelId: string): boolean => /embed|embedding/u.test(modelId.toLowerCase());

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

const listDownloadedLmStudioModels = async (cliPath: string, config: RuntimeConfig): Promise<{ ok: boolean; detail: string; models: LmStudioListedModel[] }> => {
  const result = await runCommand(cliPath, ['ls', '--llm', '--json'], config.rootDir);
  if (result.code !== 0) {
    return {
      ok: false,
      detail: result.stderr || result.stdout || 'lms ls failed',
      models: [],
    };
  }

  try {
    const payload = JSON.parse(result.stdout) as LmStudioListedModel[];
    return {
      ok: true,
      detail: 'ok',
      models: Array.isArray(payload) ? payload : [],
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'could not parse lms ls output',
      models: [],
    };
  }
};

const resolveDownloadedLmStudioModel = (models: LmStudioListedModel[], candidates: string[]): LmStudioListedModel | null => {
  for (const candidate of expandMatchCandidates(candidates)) {
    const match = models.find((model) => {
      return [model.modelKey, model.displayName, model.path, model.indexedModelIdentifier]
        .filter((value): value is string => Boolean(value?.trim()))
        .some((value) => matchesConfiguredCandidate(value, candidate));
    });
    if (match) {
      return match;
    }
  }

  return null;
};

const waitForLoadedConfiguredModel = async (config: RuntimeConfig, candidates: string[]): Promise<ServiceStatus> => {
  let lastModels: string[] = [];

  for (let attempt = 0; attempt < MODEL_BUNDLE_WAIT_ATTEMPTS; attempt += 1) {
    const models = await listLmStudioModels(config);
    lastModels = models;
    const chatModels = models.filter((model) => !isLikelyEmbeddingModel(model));
    const loaded = resolveConfiguredModelMatch(chatModels, candidates);
    if (loaded) {
      return { ok: true, detail: `matching chat model ready: ${loaded}` };
    }

    if (attempt + 1 < MODEL_BUNDLE_WAIT_ATTEMPTS) {
      await sleep(MODEL_BUNDLE_WAIT_DELAY_MS);
    }
  }

  return {
    ok: false,
    detail: `LM Studio did not surface a matching chat model in time. Loaded: ${lastModels.join(', ') || 'none'}. Candidates: ${candidates.join(', ') || 'none'}`,
  };
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

export const resolveLmStudioCliPath = (): string | null => {
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

const uniqueModelCandidates = (config: RuntimeConfig): string[] => {
  const candidates = [config.lmStudioModelHint, ...config.lmStudioModelCandidates]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(candidates)].slice(0, MAX_AUTO_MODEL_CANDIDATES);
};

export const ensureLmStudioModelBundle = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  const candidates = uniqueModelCandidates(config);
  if (candidates.length === 0) {
    return { ok: true, detail: 'no model candidates configured' };
  }

  if (!config.lmStudioAutoAcquireModels && !config.lmStudioAutoLoadPrimaryModel) {
    return { ok: true, detail: `model bundle automation disabled; candidates: ${candidates.join(', ')}` };
  }

  const runtime = await ensureLmStudio(config);
  if (!runtime.ok) {
    return runtime;
  }

  const currentlyLoaded = await listLmStudioModels(config);
  const loadedChatModels = currentlyLoaded.filter((model) => !isLikelyEmbeddingModel(model));
  const loadedMatch = resolveConfiguredModelMatch(loadedChatModels, candidates);
  if (loadedMatch) {
    return {
      ok: true,
      detail: `matching chat model already loaded: ${loadedMatch}`,
    };
  }

  const cliPath = resolveLmStudioCliPath();
  if (!cliPath) {
    return {
      ok: false,
      detail: 'LM Studio is reachable, but the bundled lms CLI was not found. Disable model auto-acquire or install the LM Studio CLI.',
    };
  }

  const acquired: string[] = [];
  const acquireFailures: string[] = [];
  let localModelsResult = await listDownloadedLmStudioModels(cliPath, config);
  let localModel = localModelsResult.ok ? resolveDownloadedLmStudioModel(localModelsResult.models, candidates) : null;

  if (!localModel && config.lmStudioAutoAcquireModels) {
    for (const candidate of expandAcquireCandidates(candidates)) {
      const result = await runCommand(cliPath, ['get', candidate, '--gguf', '--yes'], config.rootDir);
      if (result.code === 0) {
        acquired.push(candidate);
        localModelsResult = await listDownloadedLmStudioModels(cliPath, config);
        if (localModelsResult.ok) {
          localModel = resolveDownloadedLmStudioModel(localModelsResult.models, candidates);
          if (localModel) {
            break;
          }
        }
      } else {
        acquireFailures.push(`${candidate}: ${result.stderr || result.stdout || 'download failed'}`);
      }
    }
  }

  let loadDetail = 'primary model load skipped';
  let loadOk = true;
  if (config.lmStudioAutoLoadPrimaryModel) {
    if (!localModel) {
      if (!localModelsResult.ok) {
        loadOk = false;
        loadDetail = `failed to inspect downloaded LM Studio models: ${localModelsResult.detail}`;
      } else {
        const available = localModelsResult.models.map((model) => model.modelKey || model.displayName || 'unknown').filter(Boolean);
        loadOk = false;
        loadDetail = `failed to resolve a downloaded LM Studio model key for ${config.lmStudioModelHint.trim() || candidates[0]}; available local LLMs: ${available.join(', ') || 'none'}`;
      }
    } else {
      const loadTarget = localModel.modelKey?.trim() || localModel.indexedModelIdentifier?.trim() || localModel.path?.trim() || '';
      const result = await runCommand(
        cliPath,
        ['load', loadTarget, '--yes', '--identifier', LM_STUDIO_LOAD_IDENTIFIER],
        config.rootDir,
      );
      loadOk = result.code === 0;
      loadDetail = loadOk
        ? `loaded ${loadTarget} as ${LM_STUDIO_LOAD_IDENTIFIER}`
        : `failed to load ${loadTarget}: ${result.stderr || result.stdout || 'load failed'}`;

      if (loadOk) {
        const waitResult = await waitForLoadedConfiguredModel(config, candidates);
        loadOk = waitResult.ok;
        loadDetail = `${loadDetail}; ${waitResult.detail}`;
      }
    }
  }

  const details = [
    acquired.length > 0 ? `acquired: ${acquired.join(', ')}` : null,
    acquireFailures.length > 0 ? `acquire warnings: ${acquireFailures.join(' | ')}` : null,
    loadDetail,
  ].filter(Boolean);

  return {
    ok: loadOk,
    detail: details.join('; '),
  };
};
