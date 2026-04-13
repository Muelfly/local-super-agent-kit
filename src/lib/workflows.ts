import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeConfig } from './env.js';

export type ToolInputField = {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
};

export type ToolDefinition = {
  name: string;
  summary: string;
  webhookPath: string;
  responseMode?: 'responseNode' | 'lastNode';
  inputSchema?: ToolInputField[];
};

export type ToolSurfaceConfig = {
  version: number;
  tools: ToolDefinition[];
};

const DEFAULT_TOOL_SURFACE: ToolSurfaceConfig = {
  version: 1,
  tools: [],
};

const sanitizeFileName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]+/gu, '-');

const stableHex = (seed: string, length = 32): string => {
  return createHash('sha1').update(seed).digest('hex').slice(0, length);
};

const stableUuid = (seed: string): string => {
  const hex = stableHex(seed, 32).padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const stableId = (seed: string, prefix: string): string => {
  return `${prefix}-${stableHex(seed, 12)}`;
};

const normalizeInputSchema = (inputSchema: ToolInputField[] | undefined): ToolInputField[] => {
  if (!Array.isArray(inputSchema) || inputSchema.length === 0) {
    return [
      {
        name: 'payload',
        type: 'object',
        description: 'Opaque JSON payload for the generated tool surface.',
      },
    ];
  }

  return inputSchema
    .filter((field) => typeof field?.name === 'string' && typeof field?.type === 'string')
    .map((field) => ({
      name: field.name.trim(),
      type: field.type.trim(),
      required: field.required === true,
      description: typeof field.description === 'string' ? field.description.trim() : undefined,
    }))
    .filter((field) => field.name && field.type);
};

const uniqueByName = (tools: ToolDefinition[]): ToolDefinition[] => {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }
  return [...byName.values()];
};

const resolveConfigPath = (rootDir: string, configuredPath: string): string => {
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(rootDir, configuredPath);
};

export const getGeneratedSurfacePath = (config: RuntimeConfig): string => {
  return resolveConfigPath(config.rootDir, config.n8nGeneratedSurfaceFile);
};

const readSurfaceFile = async (filePath: string): Promise<ToolSurfaceConfig> => {
  if (!existsSync(filePath)) {
    return DEFAULT_TOOL_SURFACE;
  }

  const raw = JSON.parse(await readFile(filePath, 'utf8')) as Partial<ToolSurfaceConfig>;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.map((tool) => {
        const responseMode: ToolDefinition['responseMode'] = tool.responseMode === 'lastNode'
          ? 'lastNode'
          : 'responseNode';

        return {
          name: String(tool.name ?? '').trim(),
          summary: String(tool.summary ?? '').trim(),
          webhookPath: String(tool.webhookPath ?? '').trim(),
          responseMode,
          inputSchema: normalizeInputSchema(tool.inputSchema),
        };
      }).filter((tool) => tool.name && tool.summary && tool.webhookPath)
    : [];

  return {
    version: Number(raw.version ?? 1) || 1,
    tools,
  };
};

export const readMergedToolSurface = async (config: RuntimeConfig): Promise<ToolSurfaceConfig> => {
  const basePath = resolveConfigPath(config.rootDir, config.n8nToolSurfaceFile);
  const generatedPath = getGeneratedSurfacePath(config);
  const [base, generated] = await Promise.all([
    readSurfaceFile(basePath),
    readSurfaceFile(generatedPath),
  ]);

  return {
    version: Math.max(base.version, generated.version, 1),
    tools: uniqueByName([...base.tools, ...generated.tools]),
  };
};

export const upsertGeneratedTool = async (config: RuntimeConfig, tool: ToolDefinition): Promise<string> => {
  const generatedPath = getGeneratedSurfacePath(config);
  const surface = await readSurfaceFile(generatedPath);
  const nextTool: ToolDefinition = {
    name: tool.name,
    summary: tool.summary,
    webhookPath: tool.webhookPath,
    responseMode: tool.responseMode ?? 'responseNode',
    inputSchema: normalizeInputSchema(tool.inputSchema),
  };
  const tools = uniqueByName([
    ...surface.tools.filter((current) => current.name !== nextTool.name),
    nextTool,
  ]).sort((left, right) => left.name.localeCompare(right.name));

  await mkdir(path.dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, `${JSON.stringify({ version: 1, tools }, null, 2)}\n`, 'utf8');
  return generatedPath;
};

const createWebhookNode = (tool: ToolDefinition) => ({
  id: stableId(`${tool.name}:node:webhook`, 'node'),
  name: 'Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [240, 300],
  webhookId: stableUuid(`${tool.name}:webhook-id`),
  parameters: {
    httpMethod: 'POST',
    path: tool.webhookPath,
    responseMode: tool.responseMode ?? 'responseNode',
    options: {},
  },
});

const createStampNode = (tool: ToolDefinition) => ({
  id: stableId(`${tool.name}:node:stamp`, 'node'),
  name: 'Stamp Tool',
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  position: [520, 300],
  parameters: {
    assignments: {
      assignments: [
        { id: stableUuid(`${tool.name}:assignment:tool`), name: 'tool', value: tool.name, type: 'string' },
        { id: stableUuid(`${tool.name}:assignment:summary`), name: 'summary', value: tool.summary, type: 'string' },
        { id: stableUuid(`${tool.name}:assignment:payload`), name: 'payload', value: '={{$json.body ?? $json}}', type: 'object' },
        { id: stableUuid(`${tool.name}:assignment:receivedAt`), name: 'receivedAt', value: '={{$now}}', type: 'string' },
      ],
    },
    options: {},
  },
});

const createControlPlaneRequestNode = (tool: ToolDefinition, endpointPath: string) => ({
  id: stableId(`${tool.name}:node:control-plane`, 'node'),
  name: 'Control Plane',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [800, 300],
  parameters: {
    method: 'POST',
    url: endpointPath,
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody: '={{$json.payload}}',
    options: {},
  },
});

const createRespondNode = (tool: ToolDefinition) => ({
  id: stableId(`${tool.name}:node:respond`, 'node'),
  name: 'Respond',
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  position: [1080, 300],
  parameters: {
    respondWith: 'json',
    responseBody: '={{$json}}',
    options: {},
  },
});

const controlPlaneEndpointForTool = (config: RuntimeConfig, tool: ToolDefinition): string => {
  const baseUrl = config.controlPlaneBaseUrl.replace(/\/$/u, '');

  switch (tool.name) {
    case 'web.fetch':
      return `${baseUrl}/api/web.fetch`;
    case 'notes.capture':
      return `${baseUrl}/api/notes.capture`;
    case 'tool.generate':
      return `${baseUrl}/api/tool.generate`;
    default:
      return `${baseUrl}/api/tools/${encodeURIComponent(tool.name)}`;
  }
};

const createWorkflow = (config: RuntimeConfig, tool: ToolDefinition) => {
  const webhookNode = createWebhookNode(tool);
  const stampNode = createStampNode(tool);
  const requestNode = createControlPlaneRequestNode(tool, controlPlaneEndpointForTool(config, tool));
  const respondNode = createRespondNode(tool);
  const workflowSeed = `${tool.name}:${tool.webhookPath}:${tool.summary}`;

  return {
    id: stableId(workflowSeed, 'workflow'),
    versionId: stableUuid(`${workflowSeed}:version`),
    name: `tool.${tool.name}`,
    nodes: [webhookNode, stampNode, requestNode, respondNode],
    connections: {
      Webhook: {
        main: [[{ node: 'Stamp Tool', type: 'main', index: 0 }]],
      },
      'Stamp Tool': {
        main: [[{ node: 'Control Plane', type: 'main', index: 0 }]],
      },
      'Control Plane': {
        main: [[{ node: 'Respond', type: 'main', index: 0 }]],
      },
    },
    pinData: {},
    settings: {},
    staticData: null,
    meta: {
      generatedBy: 'local-super-agent-kit',
      toolName: tool.name,
      inputSchema: normalizeInputSchema(tool.inputSchema),
      controlPlaneBaseUrl: config.controlPlaneBaseUrl,
    },
    active: false,
    tags: [],
  };
};

export const getGeneratedWorkflowFilePath = (config: RuntimeConfig, toolName: string): string => {
  return path.join(config.rootDir, 'generated', 'n8n', `${sanitizeFileName(toolName)}.workflow.json`);
};

export const generateToolSurface = async (config: RuntimeConfig): Promise<string[]> => {
  const payload = await readMergedToolSurface(config);
  const targetDir = path.join(config.rootDir, 'generated', 'n8n');
  await mkdir(targetDir, { recursive: true });

  const written: string[] = [];
  for (const tool of payload.tools) {
    const workflow = createWorkflow(config, tool);
    const filePath = getGeneratedWorkflowFilePath(config, tool.name);
    await writeFile(filePath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    written.push(filePath);
  }

  return written;
};
