import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';
import { commandExists, runShellCommand } from './shell.js';
import { checkN8n, checkOpenJarvis } from './services.js';
import {
  generateToolSurface,
  getGeneratedSurfacePath,
  getGeneratedWorkflowFilePath,
  readMergedToolSurface,
  upsertGeneratedTool,
  type ToolDefinition,
  type ToolInputField,
} from './workflows.js';

type ValidationCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

type ValidationReport = {
  ok: boolean;
  checks: ValidationCheck[];
};

type EvaluationReport = {
  status: 'passed' | 'skipped' | 'failed';
  detail: string;
};

type PromotionReport = {
  status: 'imported' | 'skipped' | 'failed';
  detail: string;
};

type ToolGenerationRequest = {
  goal?: string;
  name?: string;
  summary?: string;
  webhookPath?: string;
  inputSchema?: ToolInputField[];
};

const MAX_TEXT_PREVIEW = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const stableHex = (seed: string, length = 24): string => createHash('sha1').update(seed).digest('hex').slice(0, length);

const resolveRuntimePath = (config: RuntimeConfig, ...parts: string[]): string => {
  const base = path.isAbsolute(config.runtimeStateDir)
    ? config.runtimeStateDir
    : path.join(config.rootDir, config.runtimeStateDir);
  return path.join(base, ...parts);
};

const relativeToRoot = (config: RuntimeConfig, targetPath: string): string => {
  return path.relative(config.rootDir, targetPath).split(path.sep).join('/');
};

const ensureParentDirectory = async (filePath: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
};

const writeJsonFile = async (filePath: string, payload: unknown): Promise<void> => {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const readJsonFile = async <T>(filePath: string): Promise<T> => {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
};

const sendJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
};

const parseJsonBody = async <T>(request: IncomingMessage): Promise<T> => {
  const raw = await readRequestBody(request);
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
};

const sanitizeSlug = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64) || 'tool';
};

const normalizeToolName = (value: string | undefined, goal: string): string => {
  const candidate = value?.trim().toLowerCase() || `generated.${sanitizeSlug(goal)}`;
  const cleaned = candidate.replace(/[^a-z0-9._-]+/gu, '-').replace(/\.{2,}/gu, '.');
  return cleaned.includes('.') ? cleaned : `generated.${cleaned}`;
};

const normalizeWebhookPath = (value: string | undefined, toolName: string): string => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().replace(/^\/+|\/+$/gu, '');
  }
  return `agent/generated/${sanitizeSlug(toolName.replace(/\./gu, '-'))}`;
};

const normalizeInputSchema = (fields: ToolInputField[] | undefined): ToolInputField[] => {
  if (!Array.isArray(fields) || fields.length === 0) {
    return [
      {
        name: 'payload',
        type: 'object',
        description: 'Opaque JSON payload for the generated tool branch.',
      },
    ];
  }

  return fields
    .filter((field) => typeof field?.name === 'string' && typeof field?.type === 'string')
    .map((field) => ({
      name: field.name.trim(),
      type: field.type.trim(),
      required: field.required === true,
      description: typeof field.description === 'string' ? field.description.trim() : undefined,
    }))
    .filter((field) => field.name && field.type);
};

const normalizeSummary = (value: string | undefined, goal: string): string => {
  const fallback = `Generated tool surface for: ${goal.trim()}`;
  return (value?.trim() || fallback).slice(0, 200);
};

const validateAbsoluteUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const resolveLmStudioModel = async (config: RuntimeConfig): Promise<string | null> => {
  try {
    const response = await fetch(`${config.lmStudioBaseUrl.replace(/\/$/u, '')}/models`);
    if (!response.ok) {
      return config.lmStudioModelHint || null;
    }

    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const models = Array.isArray(payload.data)
      ? payload.data.map((item) => String(item.id ?? '').trim()).filter(Boolean)
      : [];
    if (models.length === 0) {
      return config.lmStudioModelHint || null;
    }

    return models.includes(config.lmStudioModelHint) ? config.lmStudioModelHint : models[0];
  } catch {
    return config.lmStudioModelHint || null;
  }
};

const proposeToolViaLmStudio = async (
  config: RuntimeConfig,
  request: ToolGenerationRequest,
): Promise<Partial<ToolDefinition> | null> => {
  if (!request.goal?.trim()) {
    return null;
  }

  const model = await resolveLmStudioModel(config);
  if (!model) {
    return null;
  }

  const baseUrl = config.lmStudioBaseUrl.replace(/\/$/u, '');

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Return JSON only.',
              'Generate a local automation tool definition.',
              'Use ASCII only.',
              'Fields: name, summary, webhookPath, inputSchema.',
              'The name must be lower-case and safe for file names.',
              'The webhookPath must start with agent/.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              goal: request.goal,
              requestedName: request.name,
              requestedSummary: request.summary,
              requestedWebhookPath: request.webhookPath,
              requestedInputSchema: request.inputSchema,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }

    return JSON.parse(content) as Partial<ToolDefinition>;
  } catch {
    return null;
  }
};

const buildCandidateTool = async (config: RuntimeConfig, request: ToolGenerationRequest): Promise<ToolDefinition> => {
  const goal = request.goal?.trim() || 'generated automation';
  const modelSuggestion = await proposeToolViaLmStudio(config, request);

  return {
    name: normalizeToolName(request.name ?? modelSuggestion?.name, goal),
    summary: normalizeSummary(request.summary ?? modelSuggestion?.summary, goal),
    webhookPath: normalizeWebhookPath(request.webhookPath ?? modelSuggestion?.webhookPath, request.name ?? modelSuggestion?.name ?? goal),
    responseMode: 'responseNode',
    inputSchema: normalizeInputSchema(request.inputSchema ?? modelSuggestion?.inputSchema),
  };
};

const validateCandidateTool = async (config: RuntimeConfig, tool: ToolDefinition): Promise<ValidationReport> => {
  const mergedSurface = await readMergedToolSurface(config);
  const checks: ValidationCheck[] = [];

  const namePatternOk = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(tool.name);
  checks.push({
    name: 'tool-name',
    ok: namePatternOk,
    detail: namePatternOk ? 'safe tool name' : 'tool name must stay lower-case ASCII with dot, underscore, or hyphen separators.',
  });

  const webhookPatternOk = /^agent\/[a-z0-9/_-]+$/u.test(tool.webhookPath);
  checks.push({
    name: 'webhook-path',
    ok: webhookPatternOk,
    detail: webhookPatternOk ? 'safe webhook path' : 'webhookPath must start with agent/ and stay URL-safe.',
  });

  const duplicateName = mergedSurface.tools.find((entry) => entry.name === tool.name && entry.webhookPath !== tool.webhookPath);
  checks.push({
    name: 'name-collision',
    ok: duplicateName === undefined,
    detail: duplicateName ? `tool name already exists in surface: ${duplicateName.name}` : 'tool name is unique or updating in place',
  });

  const duplicateWebhook = mergedSurface.tools.find((entry) => entry.webhookPath === tool.webhookPath && entry.name !== tool.name);
  checks.push({
    name: 'webhook-collision',
    ok: duplicateWebhook === undefined,
    detail: duplicateWebhook ? `webhook path already owned by ${duplicateWebhook.name}` : 'webhook path is unique or updating in place',
  });

  const schemaOk = Array.isArray(tool.inputSchema) && tool.inputSchema.length > 0;
  checks.push({
    name: 'input-schema',
    ok: schemaOk,
    detail: schemaOk ? 'input schema is present' : 'input schema must contain at least one field.',
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
};

const validateGeneratedArtifacts = async (
  config: RuntimeConfig,
  tool: ToolDefinition,
  workflowFile: string,
): Promise<ValidationReport> => {
  const checks: ValidationCheck[] = [];
  const generatedSurfacePath = getGeneratedSurfacePath(config);

  const surfaceExists = existsSync(generatedSurfacePath);
  checks.push({
    name: 'generated-surface-file',
    ok: surfaceExists,
    detail: surfaceExists ? relativeToRoot(config, generatedSurfacePath) : 'generated surface file was not written',
  });

  if (surfaceExists) {
    const surface = await readJsonFile<{ tools?: ToolDefinition[] }>(generatedSurfacePath);
    const toolExists = Array.isArray(surface.tools) && surface.tools.some((entry) => entry.name === tool.name);
    checks.push({
      name: 'tool-surface-entry',
      ok: toolExists,
      detail: toolExists ? 'candidate stored in generated surface' : 'candidate missing from generated surface',
    });
  }

  const workflowExists = existsSync(workflowFile);
  checks.push({
    name: 'workflow-file',
    ok: workflowExists,
    detail: workflowExists ? relativeToRoot(config, workflowFile) : 'candidate workflow file missing',
  });

  if (workflowExists) {
    const workflow = await readJsonFile<{ id?: string; versionId?: string; nodes?: unknown[]; connections?: unknown }>(workflowFile);
    const structuralOk = Boolean(workflow.id && workflow.versionId && Array.isArray(workflow.nodes) && workflow.connections);
    checks.push({
      name: 'workflow-structure',
      ok: structuralOk,
      detail: structuralOk ? 'workflow JSON contains id, versionId, nodes, and connections' : 'workflow JSON is missing required n8n fields',
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
};

const evaluateGeneratedTool = async (
  config: RuntimeConfig,
  tool: ToolDefinition,
  workflowFile: string,
): Promise<EvaluationReport> => {
  if (!config.openJarvisEnabled) {
    return { status: 'skipped', detail: 'OpenJarvis lane is disabled.' };
  }

  if (!config.openJarvisEvalCommand) {
    return { status: 'skipped', detail: 'OPENJARVIS_EVAL_COMMAND is not configured.' };
  }

  const openJarvis = await checkOpenJarvis(config);
  if (!openJarvis.ok) {
    return { status: 'failed', detail: `OpenJarvis is unavailable: ${openJarvis.detail}` };
  }

  const result = await runShellCommand(config.openJarvisEvalCommand, config.rootDir, {
    AGENT_TOOL_NAME: tool.name,
    AGENT_TOOL_SUMMARY: tool.summary,
    AGENT_WORKFLOW_FILE: workflowFile,
    AGENT_GENERATED_SURFACE_FILE: getGeneratedSurfacePath(config),
  });

  if (result.code !== 0) {
    return { status: 'failed', detail: result.stderr || result.stdout || 'OpenJarvis evaluation command failed.' };
  }

  return { status: 'passed', detail: result.stdout || 'OpenJarvis evaluation passed.' };
};

const buildDefaultN8nPromoteCommand = (workflowFile: string): string => {
  return `docker compose -f compose.local.yml exec -T n8n n8n import:workflow --input=/bootstrap/generated/${path.basename(workflowFile)}`;
};

export const promoteWorkflowToN8n = async (
  config: RuntimeConfig,
  workflowFile: string,
): Promise<PromotionReport> => {
  if (!config.n8nEnabled) {
    return { status: 'skipped', detail: 'n8n lane is disabled.' };
  }

  const n8nStatus = await checkN8n(config);
  if (!n8nStatus.ok) {
    return { status: 'skipped', detail: `n8n is unavailable: ${n8nStatus.detail}` };
  }

  const usingDefaultCommand = !config.n8nPromoteCommand;
  const commandLine = config.n8nPromoteCommand || buildDefaultN8nPromoteCommand(workflowFile);
  if (usingDefaultCommand) {
    const hasDocker = await commandExists('docker', config.rootDir);
    if (!hasDocker) {
      return { status: 'skipped', detail: 'docker is not available, so the generated workflow bundle was updated but not imported.' };
    }
  }

  const result = await runShellCommand(commandLine, config.rootDir, {
    AGENT_WORKFLOW_FILE: workflowFile,
    AGENT_WORKFLOW_BASENAME: path.basename(workflowFile),
  });

  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || 'n8n promotion command failed.';
    if (usingDefaultCommand && /service\s+"?n8n"?\s+is\s+not\s+running|no\s+container|cannot\s+find/i.test(detail)) {
      return {
        status: 'skipped',
        detail: `${detail} Set N8N_PROMOTE_COMMAND if your reachable n8n is not the docker-compose service from this repo.`,
      };
    }

    return {
      status: 'failed',
      detail,
    };
  }

  return {
    status: 'imported',
    detail: result.stdout || 'workflow imported into n8n as an inactive review surface.',
  };
};

export const promoteWorkflowBundleToN8n = async (
  config: RuntimeConfig,
  workflowFiles: string[],
): Promise<PromotionReport[]> => {
  const reports: PromotionReport[] = [];
  for (const workflowFile of workflowFiles) {
    reports.push(await promoteWorkflowToN8n(config, workflowFile));
  }
  return reports;
};

const persistRecord = async (
  config: RuntimeConfig,
  category: string,
  seed: string,
  payload: Record<string, unknown>,
): Promise<string> => {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const recordName = `${timestamp}-${stableHex(seed, 10)}.json`;
  const filePath = resolveRuntimePath(config, category, recordName);
  await writeJsonFile(filePath, payload);
  return filePath;
};

const handleWebFetch = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const body = await parseJsonBody<{ url?: string }>(request);
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url || !validateAbsoluteUrl(url)) {
    sendJson(response, 400, { ok: false, error: 'Provide an absolute http or https URL.' });
    return;
  }

  const upstream = await fetch(url);
  const text = await upstream.text();
  const preview = text.slice(0, MAX_TEXT_PREVIEW);
  const recordFile = await persistRecord(config, 'web-fetch', url, {
    url,
    status: upstream.status,
    ok: upstream.ok,
    contentType: upstream.headers.get('content-type'),
    fetchedAt: new Date().toISOString(),
    body: preview,
    truncated: text.length > preview.length,
  });

  sendJson(response, 200, {
    ok: upstream.ok,
    url,
    status: upstream.status,
    contentType: upstream.headers.get('content-type'),
    body: preview,
    truncated: text.length > preview.length,
    recordFile: relativeToRoot(config, recordFile),
  });
};

const handleNotesCapture = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const body = await parseJsonBody<{ title?: string; content?: string }>(request);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!title || !content) {
    sendJson(response, 400, { ok: false, error: 'Both title and content are required.' });
    return;
  }

  const noteId = `${new Date().toISOString().slice(0, 10)}-${sanitizeSlug(title)}-${stableHex(content, 8)}`;
  const filePath = resolveRuntimePath(config, 'notes', `${noteId}.json`);
  await writeJsonFile(filePath, {
    noteId,
    title,
    content,
    capturedAt: new Date().toISOString(),
  });

  sendJson(response, 200, {
    ok: true,
    noteId,
    title,
    recordFile: relativeToRoot(config, filePath),
  });
};

const handleGenericToolInvocation = async (
  config: RuntimeConfig,
  toolName: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const payload = await parseJsonBody<Record<string, unknown>>(request);
  const invocationId = randomUUID();
  const filePath = resolveRuntimePath(config, 'tool-invocations', sanitizeSlug(toolName), `${invocationId}.json`);
  await writeJsonFile(filePath, {
    invocationId,
    toolName,
    payload,
    capturedAt: new Date().toISOString(),
  });

  sendJson(response, 200, {
    ok: true,
    tool: toolName,
    mode: 'generic-handoff',
    invocationId,
    recordFile: relativeToRoot(config, filePath),
    next: 'Replace this generic branch with a dedicated control-plane handler or a richer n8n branch when the tool stabilizes.',
  });
};

const handleToolGenerate = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<ToolGenerationRequest>(request);
  const candidate = await buildCandidateTool(config, payload);
  const candidateValidation = await validateCandidateTool(config, candidate);

  if (!candidateValidation.ok) {
    sendJson(response, 400, {
      ok: false,
      candidate,
      validation: candidateValidation,
    });
    return;
  }

  const generatedSurfacePath = await upsertGeneratedTool(config, candidate);
  const writtenFiles = await generateToolSurface(config);
  const workflowFile = getGeneratedWorkflowFilePath(config, candidate.name);
  const artifactValidation = await validateGeneratedArtifacts(config, candidate, workflowFile);
  const evaluation = artifactValidation.ok
    ? await evaluateGeneratedTool(config, candidate, workflowFile)
    : { status: 'skipped', detail: 'Skipped because artifact validation failed.' } satisfies EvaluationReport;
  const promotion = artifactValidation.ok && evaluation.status !== 'failed'
    ? await promoteWorkflowToN8n(config, workflowFile)
    : { status: 'skipped', detail: 'Skipped because validation or evaluation did not pass.' } satisfies PromotionReport;

  const jobRecordFile = await persistRecord(config, 'tool-generations', candidate.name, {
    goal: payload.goal,
    candidate,
    generatedSurfacePath: relativeToRoot(config, generatedSurfacePath),
    workflowFile: relativeToRoot(config, workflowFile),
    validation: artifactValidation,
    evaluation,
    promotion,
    writtenFiles: writtenFiles.map((filePath) => relativeToRoot(config, filePath)),
  });

  sendJson(response, 200, {
    ok: artifactValidation.ok && evaluation.status !== 'failed' && promotion.status !== 'failed',
    candidate,
    generatedSurfaceFile: relativeToRoot(config, generatedSurfacePath),
    workflowFile: relativeToRoot(config, workflowFile),
    validation: artifactValidation,
    evaluation,
    promotion,
    jobRecordFile: relativeToRoot(config, jobRecordFile),
  });
};

const handleHealth = async (config: RuntimeConfig, response: ServerResponse): Promise<void> => {
  const openJarvis = await checkOpenJarvis(config);
  sendJson(response, 200, {
    ok: true,
    controlPlaneBaseUrl: config.controlPlaneBaseUrl,
    runtimeStateDir: relativeToRoot(config, resolveRuntimePath(config)),
    generatedSurfaceFile: relativeToRoot(config, getGeneratedSurfacePath(config)),
    openJarvis: {
      enabled: config.openJarvisEnabled,
      reachable: openJarvis.ok,
      detail: openJarvis.detail,
      evalHookConfigured: Boolean(config.openJarvisEvalCommand),
    },
  });
};

const routeControlPlaneRequest = async (
  config: RuntimeConfig,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    await handleHealth(config, response);
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'Method not allowed.' });
    return;
  }

  if (url.pathname === '/api/web.fetch') {
    await handleWebFetch(config, request, response);
    return;
  }

  if (url.pathname === '/api/notes.capture') {
    await handleNotesCapture(config, request, response);
    return;
  }

  if (url.pathname === '/api/tool.generate') {
    await handleToolGenerate(config, request, response);
    return;
  }

  const genericMatch = /^\/api\/tools\/(.+)$/u.exec(url.pathname);
  if (genericMatch) {
    await handleGenericToolInvocation(config, decodeURIComponent(genericMatch[1]), request, response);
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
};

export const serveControlPlane = async (config: RuntimeConfig): Promise<Server> => {
  await mkdir(resolveRuntimePath(config), { recursive: true });

  const server = createServer((request, response) => {
    void routeControlPlaneRequest(config, request, response).catch((error) => {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Control plane request failed.',
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.controlPlanePort, config.controlPlaneHost, () => resolve());
  });

  return server;
};

export const waitForControlPlaneReady = async (config: RuntimeConfig, attempts = 20): Promise<boolean> => {
  const healthUrl = `${config.controlPlaneBaseUrl.replace(/\/$/u, '')}/healthz`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // ignore and retry
    }
    await sleep(500);
  }
  return false;
};