import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadRuntimeConfig, type RuntimeConfig } from './env.js';
import { checkLmStudio } from './lmStudio.js';
import { resolveLmStudioMcpConfigPath } from './lmstudioMcp.js';
import { getN8nAccessStatus } from './n8n.js';
import { checkControlPlane, checkHermes, checkN8n, checkNemoClaw, checkOpenJarvis, ensureControlPlane } from './services.js';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
  model?: string;
};

const asToolResult = (payload: unknown, isError = false) => {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/$/u, '');

const deriveRootUrl = (baseUrl: string): string => {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/u, '');
};

const scorePreferredModel = (model: string): number => {
  const name = model.toLowerCase();
  let score = 0;

  if (name.includes('instruct')) {
    score += 120;
  }
  if (name.includes('chat')) {
    score += 80;
  }
  if (name.includes('qwen')) {
    score += 60;
  }
  if (name.includes('nemotron')) {
    score += 40;
  }
  if (name.includes('mistral')) {
    score += 35;
  }
  if (name.includes('gemma')) {
    score += 25;
  }
  if (name.startsWith('hf.co/')) {
    score -= 30;
  }

  return score;
};

const listModels = async (baseUrl: string, apiKey = ''): Promise<string[]> => {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return Array.isArray(payload.data)
    ? payload.data.map((item) => String(item.id ?? '').trim()).filter(Boolean)
    : [];
};

const resolvePreferredModel = async (
  baseUrl: string,
  apiKey: string,
  explicitModel: string | undefined,
  configuredHint: string,
): Promise<string> => {
  if (explicitModel?.trim()) {
    return explicitModel.trim();
  }

  if (configuredHint.trim()) {
    return configuredHint.trim();
  }

  const models = await listModels(baseUrl, apiKey);
  if (models.length === 0) {
    throw new Error('No models were listed by the packaged runtime. Configure a model hint or load a model first.');
  }

  return [...models].sort((left, right) => scorePreferredModel(right) - scorePreferredModel(left))[0];
};

const checkOpenClaw = async (config: RuntimeConfig): Promise<{ ok: boolean; detail: string }> => {
  if (!config.openClawEnabled || !config.openClawBaseUrl.trim()) {
    return { ok: false, detail: 'OpenClaw is expected in this package, but the gateway is not configured' };
  }

  try {
    const response = await fetch(`${deriveRootUrl(config.openClawBaseUrl)}/healthz`, {
      headers: config.openClawApiKey ? { Authorization: `Bearer ${config.openClawApiKey}` } : {},
    });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    return { ok: true, detail: 'reachable' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'OpenClaw unreachable' };
  }
};

const callOpenAICompatibleChat = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt: string | undefined,
  temperature: number | undefined,
): Promise<Record<string, unknown>> => {
  const messages = [] as Array<Record<string, string>>;
  if (systemPrompt?.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() });
  }
  messages.push({ role: 'user', content: prompt.trim() });

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      ...(typeof temperature === 'number' ? { temperature } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json() as ChatCompletionResponse;
  return {
    model: payload.model || model,
    content: payload.choices?.[0]?.message?.content || '',
    usage: payload.usage || {},
  };
};

const callControlPlane = async (config: RuntimeConfig, endpoint: string, payload: Record<string, unknown>) => {
  const status = await ensureControlPlane(config);
  if (!status.ok) {
    throw new Error(`Control plane unavailable: ${status.detail}`);
  }

  const response = await fetch(`${normalizeBaseUrl(config.controlPlaneBaseUrl)}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(JSON.stringify(body, null, 2));
  }

  return body;
};

const buildServer = async (rootDir: string): Promise<McpServer> => {
  const config = await loadRuntimeConfig(rootDir);
  const server = new McpServer(
    {
      name: 'local-super-agent-kit',
      version: '0.1.0',
    },
    {
      instructions: [
        'LM Studio Chat is the human-facing front door for this local package.',
        'Use stack_status to inspect the local runtime before routing work.',
        'Use openjarvis_chat when you need the packaged OpenJarvis runtime inside the local chain.',
        'Use openclaw_chat through the packaged OpenClaw gateway once it is reachable.',
        'Use n8n_status, n8n_workflows, and n8n_executions when LM Studio Chat needs visibility into the hidden workflow engine.',
        'Use hermes_status to inspect the packaged Hermes runtime when you need agent-side diagnostics.',
        'Use web_fetch, notes_capture, and tool_generate for deterministic local automation through the control plane.',
        'NemoClaw is the sandboxed packaged tail of the local chain, not the primary chat surface.',
      ].join(' '),
    },
  );

  server.registerTool(
    'stack_status',
    {
      description: 'Inspect LM Studio, control-plane, n8n, OpenJarvis, OpenClaw, Hermes, and NemoClaw status behind LM Studio Chat.',
    },
    async () => {
      try {
        const [lmstudio, controlplane, n8n, n8nAccess, openjarvis, openclaw, hermes, nemoclaw] = await Promise.all([
          checkLmStudio(config),
          checkControlPlane(config),
          checkN8n(config),
          getN8nAccessStatus(config),
          checkOpenJarvis(config),
          checkOpenClaw(config),
          checkHermes(config),
          checkNemoClaw(config),
        ]);
        return asToolResult({
          lmstudio,
          controlplane,
          n8n,
          n8nAccess,
          openjarvis,
          openclaw,
          hermes,
          nemoclaw,
          lmStudioMcpConfigPath: resolveLmStudioMcpConfigPath(),
          lmStudioChatFrontDoor: true,
        });
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'n8n_status',
    {
      description: 'Ensure hidden n8n automation access is ready and report whether LM Studio Chat can inspect workflows without exposing n8n auth details.',
    },
    async () => {
      try {
        return asToolResult(await callControlPlane(config, '/api/n8n.status', {}));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'n8n_workflows',
    {
      description: 'List recent n8n workflows through the control plane so LM Studio Chat can inspect the hidden workflow surface.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of workflows to return'),
        activeOnly: z.boolean().optional().describe('Return only active workflows'),
      }),
    },
    async ({ limit, activeOnly }) => {
      try {
        return asToolResult(await callControlPlane(config, '/api/n8n.workflows', { limit, activeOnly }));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'n8n_executions',
    {
      description: 'List recent n8n executions through the control plane while keeping the workflow engine hidden behind LM Studio Chat.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of executions to return'),
        status: z.string().optional().describe('Optional execution status filter, such as success or error'),
      }),
    },
    async ({ limit, status }) => {
      try {
        return asToolResult(await callControlPlane(config, '/api/n8n.executions', { limit, status }));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'openjarvis_chat',
    {
      description: 'Route a prompt through the packaged OpenJarvis runtime while keeping LM Studio Chat as the final user endpoint.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('User prompt to delegate to OpenJarvis'),
        model: z.string().optional().describe('Optional explicit OpenJarvis model override'),
        systemPrompt: z.string().optional().describe('Optional system prompt for OpenAI-compatible chat mode'),
        temperature: z.number().min(0).max(2).optional().describe('Optional temperature override'),
      }),
    },
    async ({ prompt, model, systemPrompt, temperature }) => {
      try {
        if (!config.openJarvisEnabled) {
          return asToolResult('OpenJarvis is disabled in the local package configuration.', true);
        }

        const resolvedModel = await resolvePreferredModel(
          config.openJarvisBaseUrl,
          config.openJarvisApiKey,
          model,
          config.openJarvisModelHint,
        );

        return asToolResult(await callOpenAICompatibleChat(
          config.openJarvisBaseUrl,
          config.openJarvisApiKey,
          resolvedModel,
          prompt,
          systemPrompt,
          temperature,
        ));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'openclaw_chat',
    {
      description: 'Route a prompt through the packaged OpenClaw gateway behind LM Studio Chat.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('User prompt to delegate to OpenClaw'),
        model: z.string().optional().describe('Optional explicit OpenClaw model override'),
        systemPrompt: z.string().optional().describe('Optional system prompt'),
        temperature: z.number().min(0).max(2).optional().describe('Optional temperature override'),
      }),
    },
    async ({ prompt, model, systemPrompt, temperature }) => {
      try {
        if (!config.openClawEnabled || !config.openClawBaseUrl.trim()) {
          return asToolResult('OpenClaw is part of the packaged runtime, but it is not configured correctly. Check OPENCLAW_BASE_URL and rerun bootstrap.', true);
        }

        const resolvedModel = await resolvePreferredModel(
          config.openClawBaseUrl,
          config.openClawApiKey,
          model,
          config.openClawModel,
        );

        return asToolResult(await callOpenAICompatibleChat(
          config.openClawBaseUrl,
          config.openClawApiKey,
          resolvedModel,
          prompt,
          systemPrompt,
          temperature,
        ));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'hermes_status',
    {
      description: 'Inspect the packaged Hermes runtime that ships with the super-agent path.',
    },
    async () => {
      try {
        const status = await checkHermes(config);
        return asToolResult({
          status,
          command: config.hermesCommand,
          modelHint: config.hermesModelHint,
        });
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'nemoclaw_status',
    {
      description: 'Inspect the packaged NemoClaw sandbox/runtime tail that sits behind LM Studio Chat in this design.',
    },
    async () => {
      try {
        const status = await checkNemoClaw(config);
        return asToolResult({
          status,
          provider: config.nemoClawProvider,
          model: config.nemoClawModel,
          sandboxName: config.nemoClawSandboxName,
        });
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'web_fetch',
    {
      description: 'Fetch a URL through the local control plane so LM Studio Chat can use deterministic web fetches.',
      inputSchema: z.object({
        url: z.string().url().describe('Absolute http or https URL to fetch'),
      }),
    },
    async ({ url }) => {
      try {
        return asToolResult(await callControlPlane(config, '/api/web.fetch', { url }));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'notes_capture',
    {
      description: 'Capture a durable note through the local control plane from LM Studio Chat.',
      inputSchema: z.object({
        title: z.string().min(1).describe('Note title'),
        content: z.string().min(1).describe('Markdown note content'),
      }),
    },
    async ({ title, content }) => {
      try {
        return asToolResult(await callControlPlane(config, '/api/notes.capture', { title, content }));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'tool_generate',
    {
      description: 'Generate and validate a new local automation tool through the control plane from LM Studio Chat.',
      inputSchema: z.object({
        goal: z.string().min(1).describe('Desired automation capability'),
        name: z.string().optional().describe('Optional tool name override'),
        summary: z.string().optional().describe('Optional tool summary override'),
        webhookPath: z.string().optional().describe('Optional webhook path override'),
      }),
    },
    async ({ goal, name, summary, webhookPath }) => {
      try {
        return asToolResult(await callControlPlane(config, '/api/tool.generate', { goal, name, summary, webhookPath }));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  return server;
};

export const serveLmStudioMcp = async (rootDir: string): Promise<void> => {
  const server = await buildServer(rootDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
};