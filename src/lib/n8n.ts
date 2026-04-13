import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';
import { commandExists, runShellCommand } from './shell.js';

type StoredN8nAuthState = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  apiKey?: string;
  apiKeyId?: string;
  apiKeyLabel: string;
  updatedAt: string;
};

type SessionApiKey = {
  id?: string;
  label?: string;
  apiKey?: string;
  rawApiKey?: string;
};

type ResponsePayload = {
  text: string;
  json: unknown | null;
};

type ValidationResult = {
  ok: boolean;
  detail: string;
};

type WorkflowPayload = {
  id?: string | number;
  name?: string;
  active?: boolean;
  updatedAt?: string;
  tags?: Array<string | { name?: string }>;
};

type ExecutionPayload = {
  id?: string | number;
  status?: string;
  finished?: boolean;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
  workflowId?: string | number;
  workflowData?: {
    id?: string | number;
  };
};

export type N8nAccessStatus = {
  ok: boolean;
  reachable: boolean;
  expectedManaged: boolean;
  managedByRepo: boolean;
  apiKeyReady: boolean;
  publicApiReady: boolean;
  externalInstanceDetected: boolean;
  ownerEmail: string;
  authStateFile: string;
  showSetupOnFirstLoad: boolean | null;
  detail: string;
};

export type N8nWorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string | null;
  tags: string[];
};

export type N8nExecutionSummary = {
  id: string;
  workflowId: string | null;
  status: string | null;
  finished: boolean | null;
  mode: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
};

const DEFAULT_OWNER_EMAIL = 'local-super-agent@n8n.local';
const DEFAULT_OWNER_FIRST_NAME = 'Local';
const DEFAULT_OWNER_LAST_NAME = 'Operator';
const DEFAULT_API_KEY_LABEL = 'super-agent';
const DEFAULT_COMPOSE_FILE = 'compose.local.yml';
const DEFAULT_SERVICE_NAME = 'n8n';
const N8N_AUTH_COOKIE = 'n8n-auth';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/$/u, '');

const clampLimit = (value: number | undefined, fallback: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(value ?? fallback)));
};

const resolveRuntimeBaseDir = (config: RuntimeConfig): string => {
  return path.isAbsolute(config.runtimeStateDir)
    ? config.runtimeStateDir
    : path.join(config.rootDir, config.runtimeStateDir);
};

const resolveN8nRuntimeDir = (config: RuntimeConfig): string => {
  return path.join(resolveRuntimeBaseDir(config), 'n8n');
};

export const resolveN8nAuthStatePath = (config: RuntimeConfig): string => {
  return path.join(resolveN8nRuntimeDir(config), 'auth.json');
};

const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const writeJsonFile = async (filePath: string, payload: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const extractData = <T>(payload: unknown): T | null => {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
};

const readResponsePayload = async (response: Response): Promise<ResponsePayload> => {
  const text = await response.text();
  if (!text.trim()) {
    return { text, json: null };
  }

  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text, json: null };
  }
};

const extractMessage = (payload: ResponsePayload): string => {
  if (payload.json && typeof payload.json === 'object') {
    if ('message' in payload.json && typeof (payload.json as { message?: unknown }).message === 'string') {
      return (payload.json as { message: string }).message;
    }

    const data = extractData<{ message?: unknown }>(payload.json);
    if (data && typeof data === 'object' && typeof data.message === 'string') {
      return data.message;
    }
  }

  return payload.text.trim();
};

const getSetCookieHeaders = (response: Response): string[] => {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
};

const extractCookiePair = (response: Response, cookieName: string): string | null => {
  for (const header of getSetCookieHeaders(response)) {
    const match = header.match(new RegExp(`${cookieName}=([^;]+)`, 'u'));
    if (match) {
      return `${cookieName}=${match[1]}`;
    }
  }
  return null;
};

const isRetryableAuthRouteState = (response: Response, message: string): boolean => {
  if (response.status >= 500 || response.status === 404 || response.status === 405) {
    return true;
  }

  return /starting up|cannot (get|post|delete)|not found/i.test(message);
};

const resolveStoredOwnerEmail = (config: RuntimeConfig, stored: Partial<StoredN8nAuthState>): string => {
  return config.n8nOwnerEmail.trim() || stored.email || DEFAULT_OWNER_EMAIL;
};

const resolveConfiguredApiKey = (config: RuntimeConfig, stored: Partial<StoredN8nAuthState>): string => {
  return config.n8nApiKey.trim() || stored.apiKey?.trim() || '';
};

const generatePassword = (): string => {
  return `LocalN8n!${randomBytes(12).toString('hex')}`;
};

const readStoredAuthState = async (config: RuntimeConfig): Promise<Partial<StoredN8nAuthState>> => {
  return readJsonFile<Partial<StoredN8nAuthState>>(resolveN8nAuthStatePath(config), {});
};

const buildProvisioningState = (
  config: RuntimeConfig,
  stored: Partial<StoredN8nAuthState>,
): StoredN8nAuthState => {
  return {
    email: resolveStoredOwnerEmail(config, stored),
    password: config.n8nOwnerPassword.trim() || stored.password || generatePassword(),
    firstName: stored.firstName || DEFAULT_OWNER_FIRST_NAME,
    lastName: stored.lastName || DEFAULT_OWNER_LAST_NAME,
    apiKey: resolveConfiguredApiKey(config, stored) || undefined,
    apiKeyId: stored.apiKeyId,
    apiKeyLabel: stored.apiKeyLabel || DEFAULT_API_KEY_LABEL,
    updatedAt: new Date().toISOString(),
  };
};

const persistAuthState = async (config: RuntimeConfig, state: StoredN8nAuthState): Promise<void> => {
  await writeJsonFile(resolveN8nAuthStatePath(config), state);
};

const fetchSettings = async (config: RuntimeConfig): Promise<{ showSetupOnFirstLoad: boolean | null }> => {
  try {
    const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/rest/settings`);
    if (!response.ok) {
      return { showSetupOnFirstLoad: null };
    }

    const payload = await readResponsePayload(response);
    const settings = extractData<Record<string, unknown>>(payload.json);
    const userManagement = settings && typeof settings === 'object'
      ? settings.userManagement as Record<string, unknown> | undefined
      : undefined;
    return {
      showSetupOnFirstLoad: typeof userManagement?.showSetupOnFirstLoad === 'boolean'
        ? userManagement.showSetupOnFirstLoad
        : null,
    };
  } catch {
    return { showSetupOnFirstLoad: null };
  }
};

const isRepoComposeServiceRunning = async (config: RuntimeConfig): Promise<boolean> => {
  if (!config.n8nManagedByRepo) {
    return false;
  }

  const hasDocker = await commandExists('docker', config.rootDir);
  if (!hasDocker) {
    return false;
  }

  const commandLine = `docker compose -f ${DEFAULT_COMPOSE_FILE} ps --status running --services ${DEFAULT_SERVICE_NAME}`;
  const result = await runShellCommand(commandLine, config.rootDir);
  if (result.code !== 0) {
    return false;
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .includes(DEFAULT_SERVICE_NAME);
};

const validateWorkflowApiKey = async (config: RuntimeConfig, apiKey: string): Promise<ValidationResult> => {
  try {
    const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/api/v1/workflows?limit=1`, {
      headers: {
        'X-N8N-API-KEY': apiKey,
      },
    });
    if (response.ok) {
      return { ok: true, detail: 'workflow admin API ready' };
    }

    const payload = await readResponsePayload(response);
    const message = extractMessage(payload) || `HTTP ${response.status}`;
    return { ok: false, detail: message };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'n8n API key validation failed' };
  }
};

const setupOwnerIfNeeded = async (config: RuntimeConfig, state: StoredN8nAuthState): Promise<string | null> => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/rest/owner/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: state.email,
        firstName: state.firstName,
        lastName: state.lastName,
        password: state.password,
      }),
    });
    const payload = await readResponsePayload(response);
    const message = extractMessage(payload);
    const cookie = extractCookiePair(response, N8N_AUTH_COOKIE);

    if (response.ok) {
      return cookie;
    }

    if (response.status === 400 && /already setup/i.test(message)) {
      return null;
    }

    if (isRetryableAuthRouteState(response, message)) {
      await sleep(1_000);
      continue;
    }

    throw new Error(message || `Owner setup failed with HTTP ${response.status}`);
  }

  throw new Error('Owner setup endpoint did not become ready in time.');
};

const loginWithRetry = async (config: RuntimeConfig, state: StoredN8nAuthState): Promise<string> => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/rest/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailOrLdapLoginId: state.email,
        password: state.password,
      }),
    });
    const payload = await readResponsePayload(response);
    const message = extractMessage(payload);
    const cookie = extractCookiePair(response, N8N_AUTH_COOKIE);

    if (response.ok && cookie) {
      return cookie;
    }

    if (isRetryableAuthRouteState(response, message)) {
      await sleep(1_000);
      continue;
    }

    throw new Error(message || `Login failed with HTTP ${response.status}`);
  }

  throw new Error('n8n login did not become ready in time.');
};

const getSessionApiKeys = async (config: RuntimeConfig, cookie: string): Promise<SessionApiKey[]> => {
  const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/rest/api-keys`, {
    headers: { Cookie: cookie },
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(extractMessage(payload) || `Failed to list API keys: HTTP ${response.status}`);
  }

  const data = extractData<SessionApiKey[]>(payload.json);
  return Array.isArray(data) ? data : [];
};

const getSessionApiKeyScopes = async (config: RuntimeConfig, cookie: string): Promise<string[]> => {
  const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/rest/api-keys/scopes`, {
    headers: { Cookie: cookie },
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(extractMessage(payload) || `Failed to read API key scopes: HTTP ${response.status}`);
  }

  const data = extractData<string[]>(payload.json);
  return Array.isArray(data) ? data.filter((scope) => typeof scope === 'string' && scope.trim()) : [];
};

const deleteSessionApiKey = async (config: RuntimeConfig, cookie: string, apiKeyId: string): Promise<void> => {
  const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/rest/api-keys/${encodeURIComponent(apiKeyId)}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });

  if (response.ok || response.status === 404) {
    return;
  }

  const payload = await readResponsePayload(response);
  throw new Error(extractMessage(payload) || `Failed to delete API key ${apiKeyId}`);
};

const createSessionApiKey = async (
  config: RuntimeConfig,
  cookie: string,
  label: string,
  scopes: string[],
): Promise<{ id: string; rawApiKey: string }> => {
  const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/rest/api-keys`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      label,
      expiresAt: null,
      scopes,
    }),
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(extractMessage(payload) || `Failed to create API key: HTTP ${response.status}`);
  }

  const data = extractData<SessionApiKey>(payload.json);
  const id = typeof data?.id === 'string' ? data.id : String(data?.id ?? '');
  const rawApiKey = typeof data?.rawApiKey === 'string'
    ? data.rawApiKey
    : typeof data?.apiKey === 'string'
      ? data.apiKey
      : '';

  if (!id || !rawApiKey) {
    throw new Error('n8n returned an API key response without the raw API key value.');
  }

  return { id, rawApiKey };
};

const createOrRefreshManagedApiKey = async (
  config: RuntimeConfig,
  state: StoredN8nAuthState,
  cookie: string,
): Promise<StoredN8nAuthState> => {
  const existing = await getSessionApiKeys(config, cookie);
  const staleKeys = existing.filter((apiKey) => {
    const id = typeof apiKey.id === 'string' ? apiKey.id : String(apiKey.id ?? '');
    const label = typeof apiKey.label === 'string' ? apiKey.label : '';
    return Boolean(id) && (id === state.apiKeyId || label === state.apiKeyLabel);
  });

  for (const apiKey of staleKeys) {
    const id = typeof apiKey.id === 'string' ? apiKey.id : String(apiKey.id ?? '');
    if (id) {
      await deleteSessionApiKey(config, cookie, id);
    }
  }

  const scopes = await getSessionApiKeyScopes(config, cookie);
  if (scopes.length === 0) {
    throw new Error('n8n did not return any API key scopes for the owner account.');
  }

  const created = await createSessionApiKey(config, cookie, state.apiKeyLabel, scopes);
  const nextState: StoredN8nAuthState = {
    ...state,
    apiKey: created.rawApiKey,
    apiKeyId: created.id,
    updatedAt: new Date().toISOString(),
  };
  await persistAuthState(config, nextState);
  return nextState;
};

export const getN8nAccessStatus = async (config: RuntimeConfig): Promise<N8nAccessStatus> => {
  const stored = await readStoredAuthState(config);
  const ownerEmail = resolveStoredOwnerEmail(config, stored);
  const authStateFile = resolveN8nAuthStatePath(config);

  if (!config.n8nEnabled) {
    return {
      ok: true,
      reachable: false,
      expectedManaged: config.n8nManagedByRepo,
      managedByRepo: false,
      apiKeyReady: false,
      publicApiReady: false,
      externalInstanceDetected: false,
      ownerEmail,
      authStateFile,
      showSetupOnFirstLoad: null,
      detail: 'disabled',
    };
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}/healthz`);
    if (!response.ok) {
      return {
        ok: false,
        reachable: false,
        expectedManaged: config.n8nManagedByRepo,
        managedByRepo: false,
        apiKeyReady: false,
        publicApiReady: false,
        externalInstanceDetected: false,
        ownerEmail,
        authStateFile,
        showSetupOnFirstLoad: null,
        detail: `HTTP ${response.status}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      expectedManaged: config.n8nManagedByRepo,
      managedByRepo: false,
      apiKeyReady: false,
      publicApiReady: false,
      externalInstanceDetected: false,
      ownerEmail,
      authStateFile,
      showSetupOnFirstLoad: null,
      detail: error instanceof Error ? error.message : 'n8n unreachable',
    };
  }

  const [settings, managedByRepo] = await Promise.all([
    fetchSettings(config),
    isRepoComposeServiceRunning(config),
  ]);

  const apiKey = resolveConfiguredApiKey(config, stored);
  const validation = apiKey ? await validateWorkflowApiKey(config, apiKey) : { ok: false, detail: 'no API key configured' };
  const externalInstanceDetected = config.n8nManagedByRepo && !managedByRepo;

  if (validation.ok) {
    return {
      ok: true,
      reachable: true,
      expectedManaged: config.n8nManagedByRepo,
      managedByRepo,
      apiKeyReady: true,
      publicApiReady: true,
      externalInstanceDetected,
      ownerEmail,
      authStateFile,
      showSetupOnFirstLoad: settings.showSetupOnFirstLoad,
      detail: managedByRepo
        ? 'repo-managed n8n reachable; public API key ready'
        : 'n8n reachable; public API key ready',
    };
  }

  if (managedByRepo) {
    return {
      ok: false,
      reachable: true,
      expectedManaged: config.n8nManagedByRepo,
      managedByRepo,
      apiKeyReady: false,
      publicApiReady: false,
      externalInstanceDetected,
      ownerEmail,
      authStateFile,
      showSetupOnFirstLoad: settings.showSetupOnFirstLoad,
      detail: `repo-managed n8n reachable, but automation API access is not ready: ${validation.detail}`,
    };
  }

  if (externalInstanceDetected) {
    return {
      ok: true,
      reachable: true,
      expectedManaged: config.n8nManagedByRepo,
      managedByRepo,
      apiKeyReady: false,
      publicApiReady: false,
      externalInstanceDetected,
      ownerEmail,
      authStateFile,
      showSetupOnFirstLoad: settings.showSetupOnFirstLoad,
      detail: 'n8n is reachable, but it is not the repo compose service. Repo auto-provisioning was skipped. Stop the external instance or set N8N_MANAGED_BY_REPO=false and N8N_API_KEY=... if you want workflow tools against that instance.',
    };
  }

  return {
    ok: true,
    reachable: true,
    expectedManaged: config.n8nManagedByRepo,
    managedByRepo,
    apiKeyReady: false,
    publicApiReady: false,
    externalInstanceDetected,
    ownerEmail,
    authStateFile,
    showSetupOnFirstLoad: settings.showSetupOnFirstLoad,
    detail: config.n8nManagedByRepo
      ? `n8n reachable, but the current API key is not usable: ${validation.detail}`
      : 'external n8n reachable; set N8N_API_KEY to enable workflow inspection and LM Studio n8n tools',
  };
};

export const ensureN8nAutomationAccess = async (config: RuntimeConfig): Promise<N8nAccessStatus> => {
  const initial = await getN8nAccessStatus(config);
  if (!initial.reachable || initial.apiKeyReady || !config.n8nManagedByRepo || !initial.managedByRepo) {
    return initial;
  }

  try {
    const stored = await readStoredAuthState(config);
    const state = buildProvisioningState(config, stored);
    await persistAuthState(config, state);
    const ownerSetupCookie = await setupOwnerIfNeeded(config, state);
    const cookie = ownerSetupCookie ?? await loginWithRetry(config, state);
    await createOrRefreshManagedApiKey(config, state, cookie);
    return await getN8nAccessStatus(config);
  } catch (error) {
    return {
      ...initial,
      ok: false,
      detail: `repo-managed n8n auto-provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const resolveApiKeyForRequests = async (config: RuntimeConfig): Promise<{ status: N8nAccessStatus; apiKey: string }> => {
  const status = await ensureN8nAutomationAccess(config);
  if (!status.reachable || !status.apiKeyReady) {
    throw new Error(status.detail);
  }

  const stored = await readStoredAuthState(config);
  const apiKey = resolveConfiguredApiKey(config, stored);
  if (!apiKey) {
    throw new Error(status.detail);
  }

  return { status, apiKey };
};

const requestPublicApi = async <T>(config: RuntimeConfig, apiKey: string, pathname: string): Promise<T> => {
  const response = await fetch(`${normalizeBaseUrl(config.n8nBaseUrl)}${pathname}`, {
    headers: {
      'X-N8N-API-KEY': apiKey,
    },
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(extractMessage(payload) || `n8n public API request failed: HTTP ${response.status}`);
  }

  return extractData<T>(payload.json) as T;
};

const mapWorkflowSummary = (workflow: WorkflowPayload): N8nWorkflowSummary => {
  const tags = Array.isArray(workflow.tags)
    ? workflow.tags
      .map((tag) => (typeof tag === 'string' ? tag : typeof tag?.name === 'string' ? tag.name : ''))
      .filter(Boolean)
    : [];

  return {
    id: typeof workflow.id === 'string' ? workflow.id : String(workflow.id ?? ''),
    name: typeof workflow.name === 'string' ? workflow.name : '',
    active: workflow.active === true,
    updatedAt: typeof workflow.updatedAt === 'string' ? workflow.updatedAt : null,
    tags,
  };
};

const mapExecutionSummary = (execution: ExecutionPayload): N8nExecutionSummary => {
  return {
    id: typeof execution.id === 'string' ? execution.id : String(execution.id ?? ''),
    workflowId: typeof execution.workflowId === 'string'
      ? execution.workflowId
      : typeof execution.workflowData?.id === 'string'
        ? execution.workflowData.id
        : execution.workflowId !== undefined || execution.workflowData?.id !== undefined
          ? String(execution.workflowId ?? execution.workflowData?.id ?? '')
          : null,
    status: typeof execution.status === 'string' ? execution.status : null,
    finished: typeof execution.finished === 'boolean' ? execution.finished : null,
    mode: typeof execution.mode === 'string' ? execution.mode : null,
    startedAt: typeof execution.startedAt === 'string' ? execution.startedAt : null,
    stoppedAt: typeof execution.stoppedAt === 'string' ? execution.stoppedAt : null,
  };
};

export const listN8nWorkflows = async (
  config: RuntimeConfig,
  options: { limit?: number; activeOnly?: boolean } = {},
): Promise<{ status: N8nAccessStatus; workflows: N8nWorkflowSummary[] }> => {
  const { status, apiKey } = await resolveApiKeyForRequests(config);
  const limit = clampLimit(options.limit, 25, 100);
  const payload = await requestPublicApi<WorkflowPayload[] | { data?: WorkflowPayload[] }>(config, apiKey, `/api/v1/workflows?limit=${limit}`);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const workflows = rows
    .map(mapWorkflowSummary)
    .filter((workflow) => workflow.id && workflow.name)
    .filter((workflow) => (options.activeOnly ? workflow.active : true))
    .slice(0, limit);

  return { status, workflows };
};

export const listN8nExecutions = async (
  config: RuntimeConfig,
  options: { limit?: number; status?: string } = {},
): Promise<{ status: N8nAccessStatus; executions: N8nExecutionSummary[] }> => {
  const { status, apiKey } = await resolveApiKeyForRequests(config);
  const limit = clampLimit(options.limit, 25, 100);
  const payload = await requestPublicApi<ExecutionPayload[] | { data?: ExecutionPayload[] }>(config, apiKey, `/api/v1/executions?limit=${limit}`);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const filterStatus = options.status?.trim().toLowerCase();
  const executions = rows
    .map(mapExecutionSummary)
    .filter((execution) => execution.id)
    .filter((execution) => (filterStatus ? execution.status?.toLowerCase() === filterStatus : true))
    .slice(0, limit);

  return { status, executions };
};

export const waitForN8nReachable = async (config: RuntimeConfig, attempts = 20): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getN8nAccessStatus(config);
    if (status.reachable) {
      return true;
    }
    await sleep(1_000);
  }
  return false;
};