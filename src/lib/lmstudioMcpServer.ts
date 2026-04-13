import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadRuntimeConfig, type RuntimeConfig } from './env.js';
import { checkLmStudio, resolveConfiguredModelMatch } from './lmStudio.js';
import { resolveLmStudioMcpConfigPath } from './lmstudioMcp.js';
import { getN8nAccessStatus } from './n8n.js';
import { checkControlPlane, checkHermes, checkN8n, checkNemoClaw, checkOpenClaw, checkOpenJarvis, ensureControlPlane } from './services.js';

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

      const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/gu, '');
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(trimmed);
    }
  }

  return merged;
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
  configuredCandidates: string[],
): Promise<string> => {
  if (explicitModel?.trim()) {
    return explicitModel.trim();
  }

  const models = await listModels(baseUrl, apiKey);
  if (models.length === 0) {
    throw new Error('No models were listed by the packaged runtime. Configure a model hint or load a model first.');
  }

  const resolvedConfigured = resolveConfiguredModelMatch(models, configuredCandidates);
  if (resolvedConfigured) {
    return resolvedConfigured;
  }

  if (models.length === 1) {
    return models[0];
  }

  return [...models].sort((left, right) => scorePreferredModel(right) - scorePreferredModel(left))[0];
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

const buildSuperAgentStatusPayload = (
  config: RuntimeConfig,
  statuses: {
    lmstudio: Awaited<ReturnType<typeof checkLmStudio>>;
    controlplane: Awaited<ReturnType<typeof checkControlPlane>>;
    n8n: Awaited<ReturnType<typeof checkN8n>>;
    n8nAccess: Awaited<ReturnType<typeof getN8nAccessStatus>>;
    openjarvis: Awaited<ReturnType<typeof checkOpenJarvis>>;
    openclaw: Awaited<ReturnType<typeof checkOpenClaw>>;
    hermes: Awaited<ReturnType<typeof checkHermes>>;
    nemoclaw: Awaited<ReturnType<typeof checkNemoClaw>>;
  },
) => {
  const warnings = Object.entries({
    lmstudio: statuses.lmstudio,
    controlplane: statuses.controlplane,
    n8n: statuses.n8n,
    openjarvis: statuses.openjarvis,
    openclaw: statuses.openclaw,
    hermes: statuses.hermes,
    nemoclaw: statuses.nemoclaw,
  })
    .filter(([, status]) => !status.ok)
    .map(([name, status]) => `${name}: ${status.detail}`);

  return {
    identity: {
      product: 'Super Agent',
      frontDoor: 'LM Studio Chat',
      mcpServer: 'super-agent',
      selectedLmStudioModelRole: 'reasoning-shell',
      modelAgnosticExperience: true,
      lmStudioMcpConfigPath: resolveLmStudioMcpConfigPath(),
    },
    contract: {
      actAs: 'Super Agent',
      hideInternalLaneNamesByDefault: true,
      mentionInternalLanesOnlyWhenDiagnosing: true,
      defaultBehavior: 'Treat the currently selected LM Studio chat model as the reasoning shell and the MCP tool surface as the real product capability layer.',
    },
    capabilities: {
      reasoning: ['super_agent_reason', 'super_agent_delegate'],
      automation: ['super_agent_fetch', 'super_agent_notes', 'super_agent_tool_generate', 'super_agent_workflow_design'],
      visibility: ['super_agent_status', 'super_agent_automation_status', 'super_agent_workflows', 'super_agent_workflow_runs'],
      runtime: ['super_agent_runtime_status', 'super_agent_sandbox_status'],
    },
    recommendedFirstMove: 'Call super_agent_status at session start or whenever runtime readiness is unclear.',
    warnings,
    services: {
      lmstudio: statuses.lmstudio,
      controlplane: statuses.controlplane,
      n8n: statuses.n8n,
      n8nAccess: statuses.n8nAccess,
      openjarvis: statuses.openjarvis,
      openclaw: statuses.openclaw,
      hermes: statuses.hermes,
      nemoclaw: statuses.nemoclaw,
    },
    packageDefaults: {
      lmStudioCandidates: config.lmStudioModelCandidates,
      openJarvisCandidates: config.openJarvisModelCandidates,
      openClawCandidates: config.openClawModelCandidates,
      hermesCandidates: config.hermesModelCandidates,
      nemoClawCandidates: config.nemoClawModelCandidates,
    },
  };
};

const buildServer = async (rootDir: string): Promise<McpServer> => {
  const config = await loadRuntimeConfig(rootDir);
  const server = new McpServer(
    {
      name: 'super-agent',
      version: '0.1.0',
    },
    {
      instructions: [
        'When this MCP server is active, present the experience as Super Agent.',
        'LM Studio Chat is the human-facing front door, but the currently selected chat model is only the reasoning shell.',
        'Do not frame the experience as the raw base model unless the user explicitly asks about model identity.',
        'Use super_agent_status early when runtime readiness is unclear.',
        'Prefer Super Agent tool names in your planning and replies.',
        'Keep OpenJarvis, OpenClaw, Hermes, and NemoClaw internal unless you are diagnosing a runtime issue or the user asks for lane-level details.',
        'Use super_agent_reason and super_agent_delegate for internal reasoning or delegation through packaged runtimes.',
        'Use super_agent_fetch, super_agent_notes, super_agent_tool_generate, and super_agent_workflow_design for deterministic automation through the control plane.',
        'Use super_agent_automation_status, super_agent_workflows, and super_agent_workflow_runs when you need visibility into the hidden workflow engine.',
        'Treat Super Agent as one unified local product regardless of which LM Studio chat model is currently selected.',
      ].join(' '),
    },
  );

  server.registerTool(
    'super_agent_status',
    {
      description: 'Inspect the unified Super Agent runtime behind LM Studio Chat and return the current product contract, capabilities, and subsystem readiness.',
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
        return asToolResult(buildSuperAgentStatusPayload(config, {
          lmstudio,
          controlplane,
          n8n,
          n8nAccess,
          openjarvis,
          openclaw,
          hermes,
          nemoclaw,
        }));
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'super_agent_automation_status',
    {
      description: 'Report whether the Super Agent automation plane can inspect and manage hidden n8n workflows without exposing auth details to the user.',
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
    'super_agent_workflows',
    {
      description: 'List recent Super Agent automation workflows through the control plane.',
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
    'super_agent_workflow_runs',
    {
      description: 'List recent Super Agent workflow runs through the control plane while keeping the internal workflow engine hidden.',
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
    'super_agent_reason',
    {
      description: 'Run an internal Super Agent reasoning pass through the packaged reasoning lane while keeping the final user experience unified.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Goal or prompt to send through the packaged reasoning lane'),
        model: z.string().optional().describe('Optional explicit reasoning-lane model override'),
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
          collectModelCandidates(
            config.openJarvisModelHint,
            config.openJarvisModelCandidates,
            config.lmStudioModelHint,
            config.lmStudioModelCandidates,
          ),
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
    'super_agent_delegate',
    {
      description: 'Delegate a prompt through the packaged Super Agent gateway lane when the deeper agent surface is ready.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Goal or prompt to delegate through the packaged gateway lane'),
        model: z.string().optional().describe('Optional explicit delegated-lane model override'),
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
          collectModelCandidates(
            config.openClawModel,
            config.openClawModelCandidates,
            config.lmStudioModelHint,
            config.lmStudioModelCandidates,
          ),
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
    'super_agent_runtime_status',
    {
      description: 'Inspect the packaged Super Agent runtime lane used for repo-local runtime diagnostics.',
    },
    async () => {
      try {
        const status = await checkHermes(config);
        return asToolResult({
          status,
          command: config.hermesCommand,
          modelHint: config.hermesModelHint,
          modelCandidates: config.hermesModelCandidates,
        });
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'super_agent_sandbox_status',
    {
      description: 'Inspect the packaged Super Agent sandbox/runtime tail that sits behind LM Studio Chat.',
    },
    async () => {
      try {
        const status = await checkNemoClaw(config);
        return asToolResult({
          status,
          provider: config.nemoClawProvider,
          model: config.nemoClawModel,
          modelCandidates: config.nemoClawModelCandidates,
          sandboxName: config.nemoClawSandboxName,
        });
      } catch (error) {
        return asToolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'super_agent_fetch',
    {
      description: 'Fetch a URL through the Super Agent control plane so the chat experience can use deterministic web access.',
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
    'super_agent_notes',
    {
      description: 'Capture a durable note through the Super Agent control plane from LM Studio Chat.',
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
    'super_agent_tool_generate',
    {
      description: 'Generate and validate a new local Super Agent automation tool through the control plane.',
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

  server.registerTool(
    'super_agent_workflow_design',
    {
      description: 'Design a richer Super Agent automation workflow draft and optionally scaffold its local review artifacts.',
      inputSchema: z.object({
        goal: z.string().min(1).describe('Desired automation or workflow outcome'),
        name: z.string().optional().describe('Optional workflow or tool name override'),
        summary: z.string().optional().describe('Optional workflow summary override'),
        webhookPath: z.string().optional().describe('Optional webhook path override'),
        constraints: z.array(z.string().min(1)).optional().describe('Optional hard constraints for the workflow draft'),
        integrateWithTools: z.array(z.string().min(1)).optional().describe('Optional existing tool names to reference in the draft'),
        autoGenerateTool: z.boolean().optional().describe('When true, also scaffold the generated tool surface and workflow JSON'),
        promoteToN8n: z.boolean().optional().describe('When true, import the scaffolded workflow into n8n as an inactive review surface'),
      }),
    },
    async ({ goal, name, summary, webhookPath, constraints, integrateWithTools, autoGenerateTool, promoteToN8n }) => {
      try {
        return asToolResult(await callControlPlane(config, '/api/n8n.workflow.design', {
          goal,
          name,
          summary,
          webhookPath,
          constraints,
          integrateWithTools,
          autoGenerateTool,
          promoteToN8n,
        }));
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