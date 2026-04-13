import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';
import { resolveConfiguredModelMatch } from './lmStudio.js';
import { ensureN8nAutomationAccess, getN8nAccessStatus, listN8nExecutions, listN8nWorkflows } from './n8n.js';
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

type WorkflowDesignRequest = ToolGenerationRequest & {
  constraints?: string[];
  integrateWithTools?: string[];
  autoGenerateTool?: boolean;
  promoteToN8n?: boolean;
};

type WorkflowDesignStep = {
  key: string;
  label: string;
  kind: string;
  summary: string;
  nodeType?: string;
  dependsOn?: string[];
};

type WorkflowDesignDraft = {
  name: string;
  workflowName: string;
  summary: string;
  goal: string;
  webhookPath: string;
  responseMode: 'responseNode' | 'lastNode';
  inputSchema: ToolInputField[];
  draftNodes: WorkflowDesignStep[];
  constraints: string[];
  integrateWithTools: string[];
  openQuestions: string[];
  nextActions: string[];
};

type N8nWorkflowListRequest = {
  limit?: number;
  activeOnly?: boolean;
};

type N8nExecutionListRequest = {
  limit?: number;
  status?: string;
};

type WorkspaceListRequest = {
  path?: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxEntries?: number;
};

type WorkspaceReadRequest = {
  path?: string;
  startLine?: number;
  endLine?: number;
};

type WorkspaceWriteRequest = {
  path?: string;
  content?: string;
  mode?: 'overwrite' | 'append';
};

type WorkspaceShellRequest = {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
};

const MAX_TEXT_PREVIEW = 20_000;
const MAX_WORKSPACE_LIST_ENTRIES = 500;
const MAX_WORKSPACE_READ_LINES = 400;
const MAX_WORKSPACE_WRITE_BYTES = 1_000_000;
const MAX_WORKSPACE_COMMAND_OUTPUT = 25_000;
const DEFAULT_WORKSPACE_SHELL_TIMEOUT_MS = 120_000;
const MAX_WORKSPACE_SHELL_TIMEOUT_MS = 300_000;

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

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const isPathInsideRoot = (rootDir: string, targetPath: string): boolean => {
  const relative = path.relative(rootDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveWorkspaceTarget = (config: RuntimeConfig, requestedPath: string | undefined, allowRoot = true): string => {
  const normalized = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  if (!normalized) {
    if (!allowRoot) {
      throw new Error('A workspace path is required.');
    }

    return config.rootDir;
  }

  const target = path.resolve(config.rootDir, normalized);
  if (!isPathInsideRoot(config.rootDir, target)) {
    throw new Error('Requested path must stay inside the workspace root.');
  }

  return target;
};

const relativeWorkspacePath = (config: RuntimeConfig, targetPath: string): string => {
  const relative = relativeToRoot(config, targetPath);
  return relative || '.';
};

const truncateText = (value: string, maxLength: number): { text: string; truncated: boolean } => {
  if (value.length <= maxLength) {
    return { text: value, truncated: false };
  }

  return {
    text: `${value.slice(0, maxLength)}\n...[truncated]`,
    truncated: true,
  };
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

const normalizeStringList = (values: unknown, maxItems = 12): string[] => {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems);
};

const normalizeResponseMode = (value: unknown): 'responseNode' | 'lastNode' => {
  return value === 'lastNode' ? 'lastNode' : 'responseNode';
};

const buildDefaultDraftNodes = (toolName: string, integrateWithTools: string[]): WorkflowDesignStep[] => {
  const nodes: WorkflowDesignStep[] = [
    {
      key: 'webhook-intake',
      label: 'Webhook Intake',
      kind: 'trigger',
      summary: 'Accept the workflow request over the generated webhook surface.',
      nodeType: 'n8n-nodes-base.webhook',
    },
    {
      key: 'shape-payload',
      label: 'Shape Payload',
      kind: 'transform',
      summary: 'Normalize the inbound payload and stamp request metadata for downstream nodes.',
      nodeType: 'n8n-nodes-base.set',
      dependsOn: ['webhook-intake'],
    },
  ];

  for (const tool of integrateWithTools) {
    nodes.push({
      key: sanitizeSlug(`tool-${tool}`),
      label: `Call ${tool}`,
      kind: 'tool',
      summary: `Invoke the existing ${tool} surface when the workflow needs that reusable capability.`,
      dependsOn: ['shape-payload'],
    });
  }

  nodes.push(
    {
      key: 'control-plane-handoff',
      label: 'Control Plane Handoff',
      kind: 'control-plane',
      summary: `Send the normalized payload into the ${toolName} control-plane branch or a dedicated future handler.`,
      nodeType: 'n8n-nodes-base.httpRequest',
      dependsOn: integrateWithTools.length > 0
        ? integrateWithTools.map((tool) => sanitizeSlug(`tool-${tool}`))
        : ['shape-payload'],
    },
    {
      key: 'respond',
      label: 'Respond',
      kind: 'response',
      summary: 'Return the final JSON result to the caller without exposing internal runtime details.',
      nodeType: 'n8n-nodes-base.respondToWebhook',
      dependsOn: ['control-plane-handoff'],
    },
  );

  return nodes;
};

const normalizeDraftNodes = (
  value: unknown,
  toolName: string,
  integrateWithTools: string[],
): WorkflowDesignStep[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return buildDefaultDraftNodes(toolName, integrateWithTools);
  }

  const nodes = value
    .map((entry, index): WorkflowDesignStep | null => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const label = typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : `Step ${index + 1}`;
      const key = sanitizeSlug(typeof record.key === 'string' && record.key.trim() ? record.key : label);
      const summary = typeof record.summary === 'string' && record.summary.trim()
        ? record.summary.trim()
        : `Implement ${label.toLowerCase()} in the generated workflow.`;

      return {
        key,
        label,
        kind: typeof record.kind === 'string' && record.kind.trim() ? record.kind.trim() : 'transform',
        summary,
        nodeType: typeof record.nodeType === 'string' && record.nodeType.trim() ? record.nodeType.trim() : undefined,
        dependsOn: normalizeStringList(record.dependsOn).map((item) => sanitizeSlug(item)),
      };
    })
    .filter((entry): entry is WorkflowDesignStep => entry !== null);

  return nodes.length > 0 ? nodes : buildDefaultDraftNodes(toolName, integrateWithTools);
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

    const chatModels = models.filter((model) => !/embed|embedding/u.test(model.toLowerCase()));
    const matched = resolveConfiguredModelMatch(chatModels, [config.lmStudioModelHint, ...config.lmStudioModelCandidates]);
    if (matched) {
      return matched;
    }

    return chatModels[0] || models[0];
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

const proposeWorkflowDesignViaLmStudio = async (
  config: RuntimeConfig,
  request: WorkflowDesignRequest,
): Promise<Partial<WorkflowDesignDraft> | null> => {
  if (!request.goal?.trim()) {
    return null;
  }

  const model = await resolveLmStudioModel(config);
  if (!model) {
    return null;
  }

  const baseUrl = config.lmStudioBaseUrl.replace(/\/$/u, '');
  const knownTools = (await readMergedToolSurface(config)).tools.map((tool) => tool.name);

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
              'Design a local-first n8n workflow draft for deterministic automation.',
              'Use ASCII only.',
              'Fields: name, summary, webhookPath, responseMode, inputSchema, draftNodes, openQuestions, nextActions, constraints, integrateWithTools.',
              'Each draftNodes item must contain key, label, kind, summary, and may include nodeType and dependsOn.',
              'Prefer control-plane calls and existing local tools before inventing new remote dependencies.',
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
              constraints: request.constraints,
              integrateWithTools: request.integrateWithTools,
              knownTools,
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

    return JSON.parse(content) as Partial<WorkflowDesignDraft>;
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

const buildWorkflowDesignDraft = async (
  config: RuntimeConfig,
  request: WorkflowDesignRequest,
): Promise<WorkflowDesignDraft> => {
  const goal = request.goal?.trim() || 'generated automation';
  const suggestion = await proposeWorkflowDesignViaLmStudio(config, request);
  const name = normalizeToolName(request.name ?? suggestion?.name, goal);
  const integrateWithTools = normalizeStringList(request.integrateWithTools ?? suggestion?.integrateWithTools, 16);

  return {
    name,
    workflowName: `tool.${name}`,
    summary: normalizeSummary(request.summary ?? suggestion?.summary, goal),
    goal,
    webhookPath: normalizeWebhookPath(request.webhookPath ?? suggestion?.webhookPath, name),
    responseMode: normalizeResponseMode(suggestion?.responseMode),
    inputSchema: normalizeInputSchema(request.inputSchema ?? suggestion?.inputSchema),
    draftNodes: normalizeDraftNodes(suggestion?.draftNodes, name, integrateWithTools),
    constraints: normalizeStringList(request.constraints ?? suggestion?.constraints, 16),
    integrateWithTools,
    openQuestions: normalizeStringList(suggestion?.openQuestions, 12),
    nextActions: normalizeStringList(suggestion?.nextActions, 12),
  };
};

const writeWorkflowDesignDraft = async (
  config: RuntimeConfig,
  draft: WorkflowDesignDraft,
  request: WorkflowDesignRequest,
): Promise<string> => {
  const filePath = resolveRuntimePath(config, 'workflow-designs', `${sanitizeSlug(draft.name)}.json`);
  await writeJsonFile(filePath, {
    generatedAt: new Date().toISOString(),
    request,
    draft,
  });
  return filePath;
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

const handleWorkspaceList = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<WorkspaceListRequest>(request);

  try {
    const basePath = resolveWorkspaceTarget(config, payload.path, true);
    const recursive = payload.recursive === true;
    const includeHidden = payload.includeHidden === true;
    const maxDepth = recursive ? clampInteger(payload.maxDepth, 6, 1, 32) : 1;
    const maxEntries = clampInteger(payload.maxEntries, 200, 1, MAX_WORKSPACE_LIST_ENTRIES);
    const queue = [{ absolutePath: basePath, depth: 0 }];
    const entries: Array<{ path: string; type: 'directory' | 'file' | 'symlink' | 'other'; depth: number }> = [];

    while (queue.length > 0 && entries.length < maxEntries) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      const children = await readdir(current.absolutePath, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));

      for (const child of children) {
        if (!includeHidden && child.name.startsWith('.')) {
          continue;
        }

        const absolutePath = path.join(current.absolutePath, child.name);
        const type = child.isDirectory()
          ? 'directory'
          : child.isFile()
            ? 'file'
            : child.isSymbolicLink()
              ? 'symlink'
              : 'other';

        entries.push({
          path: relativeWorkspacePath(config, absolutePath),
          type,
          depth: current.depth + 1,
        });

        if (entries.length >= maxEntries) {
          break;
        }

        if (recursive && child.isDirectory() && current.depth + 1 < maxDepth) {
          queue.push({ absolutePath, depth: current.depth + 1 });
        }
      }
    }

    sendJson(response, 200, {
      ok: true,
      basePath: relativeWorkspacePath(config, basePath),
      recursive,
      includeHidden,
      maxDepth,
      maxEntries,
      entries,
      truncated: entries.length >= maxEntries,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to list workspace files.',
    });
  }
};

const handleWorkspaceRead = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<WorkspaceReadRequest>(request);

  try {
    const targetPath = resolveWorkspaceTarget(config, payload.path, false);
    const content = await readFile(targetPath, 'utf8');
    const lines = content === '' ? [] : content.split(/\r?\n/u);
    const totalLines = lines.length;
    const startLine = clampInteger(payload.startLine, 1, 1, Math.max(totalLines, 1));
    const defaultEndLine = Math.min(Math.max(totalLines, 1), startLine + MAX_WORKSPACE_READ_LINES - 1);
    const endLine = clampInteger(payload.endLine, defaultEndLine, startLine, startLine + MAX_WORKSPACE_READ_LINES - 1);
    const slice = totalLines === 0 ? [] : lines.slice(startLine - 1, Math.min(endLine, totalLines));

    sendJson(response, 200, {
      ok: true,
      path: relativeWorkspacePath(config, targetPath),
      startLine,
      endLine: totalLines === 0 ? 0 : Math.min(endLine, totalLines),
      totalLines,
      content: slice.join('\n'),
      truncated: totalLines > 0 && endLine < totalLines,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to read workspace file.',
    });
  }
};

const handleWorkspaceWrite = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<WorkspaceWriteRequest>(request);

  try {
    const targetPath = resolveWorkspaceTarget(config, payload.path, false);
    if (typeof payload.content !== 'string') {
      sendJson(response, 400, { ok: false, error: 'content must be a string.' });
      return;
    }

    const bytes = Buffer.byteLength(payload.content, 'utf8');
    if (bytes > MAX_WORKSPACE_WRITE_BYTES) {
      sendJson(response, 400, {
        ok: false,
        error: `content exceeds the ${MAX_WORKSPACE_WRITE_BYTES} byte limit for direct workspace writes.`,
      });
      return;
    }

    await ensureParentDirectory(targetPath);
    const mode = payload.mode === 'append' ? 'append' : 'overwrite';
    if (mode === 'append' && existsSync(targetPath)) {
      await appendFile(targetPath, payload.content, 'utf8');
    } else {
      await writeFile(targetPath, payload.content, 'utf8');
    }

    sendJson(response, 200, {
      ok: true,
      path: relativeWorkspacePath(config, targetPath),
      mode,
      bytesWritten: bytes,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to write workspace file.',
    });
  }
};

const handleWorkspaceShell = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<WorkspaceShellRequest>(request);
  const command = typeof payload.command === 'string' ? payload.command.trim() : '';

  if (!command) {
    sendJson(response, 400, { ok: false, error: 'command is required.' });
    return;
  }

  try {
    const cwd = resolveWorkspaceTarget(config, payload.cwd, true);
    const timeoutMs = clampInteger(payload.timeoutMs, DEFAULT_WORKSPACE_SHELL_TIMEOUT_MS, 1, MAX_WORKSPACE_SHELL_TIMEOUT_MS);
    const result = await runShellCommand(command, cwd, {}, { timeoutMs });
    const stdout = truncateText(result.stdout, MAX_WORKSPACE_COMMAND_OUTPUT);
    const stderr = truncateText(result.stderr, MAX_WORKSPACE_COMMAND_OUTPUT);

    sendJson(response, 200, {
      ok: result.code === 0,
      command,
      cwd: relativeWorkspacePath(config, cwd),
      code: result.code,
      timedOut: result.timedOut === true,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to execute workspace shell command.',
    });
  }
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

const handleWorkflowDesign = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<WorkflowDesignRequest>(request);
  if (!payload.goal?.trim()) {
    sendJson(response, 400, { ok: false, error: 'goal is required.' });
    return;
  }

  const draft = await buildWorkflowDesignDraft(config, payload);
  const candidate: ToolDefinition = {
    name: draft.name,
    summary: draft.summary,
    webhookPath: draft.webhookPath,
    responseMode: draft.responseMode,
    inputSchema: draft.inputSchema,
  };
  const candidateValidation = await validateCandidateTool(config, candidate);
  const draftFile = await writeWorkflowDesignDraft(config, draft, payload);

  if (!candidateValidation.ok) {
    sendJson(response, 400, {
      ok: false,
      draft,
      draftFile: relativeToRoot(config, draftFile),
      candidate,
      validation: candidateValidation,
    });
    return;
  }

  if (payload.autoGenerateTool === false) {
    sendJson(response, 200, {
      ok: true,
      draft,
      draftFile: relativeToRoot(config, draftFile),
      candidate,
      validation: candidateValidation,
      next: 'Set autoGenerateTool=true to scaffold a review workflow and generated tool surface.',
    });
    return;
  }

  const generatedSurfacePath = await upsertGeneratedTool(config, candidate);
  const writtenFiles = await generateToolSurface(config);
  const workflowFile = getGeneratedWorkflowFilePath(config, candidate.name);
  const artifactValidation = await validateGeneratedArtifacts(config, candidate, workflowFile);
  const evaluation = {
    status: 'skipped',
    detail: 'Workflow design scaffolding skips the OpenJarvis eval hook by default.',
  } satisfies EvaluationReport;
  const promotion = payload.promoteToN8n === true && artifactValidation.ok
    ? await promoteWorkflowToN8n(config, workflowFile)
    : {
        status: 'skipped',
        detail: payload.promoteToN8n === true
          ? 'Skipped because artifact validation did not pass.'
          : 'Skipped because promoteToN8n was not requested.',
      } satisfies PromotionReport;

  const jobRecordFile = await persistRecord(config, 'workflow-design-jobs', candidate.name, {
    goal: payload.goal,
    candidate,
    draft,
    draftFile: relativeToRoot(config, draftFile),
    generatedSurfacePath: relativeToRoot(config, generatedSurfacePath),
    workflowFile: relativeToRoot(config, workflowFile),
    validation: artifactValidation,
    evaluation,
    promotion,
    writtenFiles: writtenFiles.map((filePath) => relativeToRoot(config, filePath)),
  });

  sendJson(response, 200, {
    ok: artifactValidation.ok && promotion.status !== 'failed',
    draft,
    draftFile: relativeToRoot(config, draftFile),
    candidate,
    generatedSurfaceFile: relativeToRoot(config, generatedSurfacePath),
    workflowFile: relativeToRoot(config, workflowFile),
    validation: artifactValidation,
    evaluation,
    promotion,
    jobRecordFile: relativeToRoot(config, jobRecordFile),
  });
};

const handleN8nStatus = async (config: RuntimeConfig, response: ServerResponse): Promise<void> => {
  const status = await ensureN8nAutomationAccess(config);
  sendJson(response, 200, {
    ok: status.ok,
    status,
  });
};

const handleN8nWorkflows = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<N8nWorkflowListRequest>(request);

  try {
    const result = await listN8nWorkflows(config, {
      limit: typeof payload.limit === 'number' ? payload.limit : undefined,
      activeOnly: payload.activeOnly === true,
    });

    sendJson(response, 200, {
      ok: true,
      status: result.status,
      workflows: result.workflows,
      count: result.workflows.length,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to list n8n workflows.',
      status: await getN8nAccessStatus(config),
    });
  }
};

const handleN8nExecutions = async (config: RuntimeConfig, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const payload = await parseJsonBody<N8nExecutionListRequest>(request);

  try {
    const result = await listN8nExecutions(config, {
      limit: typeof payload.limit === 'number' ? payload.limit : undefined,
      status: typeof payload.status === 'string' ? payload.status : undefined,
    });

    sendJson(response, 200, {
      ok: true,
      status: result.status,
      executions: result.executions,
      count: result.executions.length,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to list n8n executions.',
      status: await getN8nAccessStatus(config),
    });
  }
};

const handleHealth = async (config: RuntimeConfig, response: ServerResponse): Promise<void> => {
  const [openJarvis, n8nAccess] = await Promise.all([
    checkOpenJarvis(config),
    getN8nAccessStatus(config),
  ]);
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
    n8n: n8nAccess,
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

  if (url.pathname === '/api/workspace.list') {
    await handleWorkspaceList(config, request, response);
    return;
  }

  if (url.pathname === '/api/workspace.read') {
    await handleWorkspaceRead(config, request, response);
    return;
  }

  if (url.pathname === '/api/workspace.write') {
    await handleWorkspaceWrite(config, request, response);
    return;
  }

  if (url.pathname === '/api/workspace.shell') {
    await handleWorkspaceShell(config, request, response);
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

  if (url.pathname === '/api/n8n.workflow.design') {
    await handleWorkflowDesign(config, request, response);
    return;
  }

  if (url.pathname === '/api/n8n.status') {
    await handleN8nStatus(config, response);
    return;
  }

  if (url.pathname === '/api/n8n.workflows') {
    await handleN8nWorkflows(config, request, response);
    return;
  }

  if (url.pathname === '/api/n8n.executions') {
    await handleN8nExecutions(config, request, response);
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