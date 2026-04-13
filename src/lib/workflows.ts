import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from './env.js';

export type ToolSurfaceConfig = {
  version: number;
  tools: Array<{
    name: string;
    summary: string;
    webhookPath: string;
    responseMode?: 'responseNode' | 'lastNode';
    inputSchema?: Array<{ name: string; type: string; required?: boolean; description?: string }>;
  }>;
};

const sanitizeFileName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]+/gu, '-');

const createWorkflow = (tool: ToolSurfaceConfig['tools'][number]) => {
  const webhookNodeId = randomUUID();
  const setNodeId = randomUUID();
  const respondNodeId = randomUUID();

  return {
    name: `tool.${tool.name}`,
    nodes: [
      {
        id: webhookNodeId,
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [240, 300],
        webhookId: randomUUID(),
        parameters: {
          httpMethod: 'POST',
          path: tool.webhookPath,
          responseMode: tool.responseMode ?? 'responseNode',
          options: {},
        },
      },
      {
        id: setNodeId,
        name: 'Stamp Tool',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [520, 300],
        parameters: {
          assignments: {
            assignments: [
              { id: randomUUID(), name: 'tool', value: tool.name, type: 'string' },
              { id: randomUUID(), name: 'summary', value: tool.summary, type: 'string' },
              { id: randomUUID(), name: 'payload', value: '={{$json.body}}', type: 'object' },
            ],
          },
          options: {},
        },
      },
      {
        id: respondNodeId,
        name: 'Respond',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [780, 300],
        parameters: {
          respondWith: 'json',
          responseBody: '={{ { ok: true, tool: $json.tool, summary: $json.summary, payload: $json.payload, next: "Replace this placeholder branch with real automation." } }}',
          options: {},
        },
      },
    ],
    connections: {
      Webhook: {
        main: [[{ node: 'Stamp Tool', type: 'main', index: 0 }]],
      },
      'Stamp Tool': {
        main: [[{ node: 'Respond', type: 'main', index: 0 }]],
      },
    },
    pinData: {},
    settings: {},
    staticData: null,
    meta: {
      generatedBy: 'local-super-agent-kit',
      inputSchema: tool.inputSchema ?? [],
    },
    active: false,
    tags: [],
    versionId: randomUUID(),
  };
};

export const generateToolSurface = async (config: RuntimeConfig): Promise<string[]> => {
  const sourcePath = path.join(config.rootDir, config.n8nToolSurfaceFile);
  const targetDir = path.join(config.rootDir, 'generated', 'n8n');
  const payload = JSON.parse(await readFile(sourcePath, 'utf8')) as ToolSurfaceConfig;
  await mkdir(targetDir, { recursive: true });

  const written: string[] = [];
  for (const tool of payload.tools) {
    const workflow = createWorkflow(tool);
    const filePath = path.join(targetDir, `${sanitizeFileName(tool.name)}.workflow.json`);
    await writeFile(filePath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    written.push(filePath);
  }

  return written;
};
