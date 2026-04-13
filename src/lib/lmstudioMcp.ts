import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LM_STUDIO_MCP_SERVER_NAME = 'super-agent';
const LEGACY_LM_STUDIO_MCP_SERVER_NAMES = ['local-super-agent-kit'];

type LmStudioProgramServer = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type LmStudioMcpConfig = {
  mcpServers: Record<string, LmStudioProgramServer | Record<string, unknown>>;
};

const resolveLmStudioHome = (): string => {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    throw new Error('Unable to resolve the user home directory for LM Studio MCP installation.');
  }

  return path.join(home, '.lmstudio');
};

export const resolveLmStudioMcpConfigPath = (): string => {
  return path.join(resolveLmStudioHome(), 'mcp.json');
};

export const buildLmStudioMcpServerConfig = (rootDir: string): LmStudioProgramServer => {
  return {
    command: process.execPath,
    args: ['--import', 'tsx', path.join(rootDir, 'src', 'cli.ts'), 'serve-lmstudio-mcp'],
    cwd: rootDir,
    env: {
      FORCE_COLOR: '0',
    },
  };
};

const readExistingMcpConfig = async (filePath: string): Promise<LmStudioMcpConfig> => {
  if (!existsSync(filePath)) {
    return { mcpServers: {} };
  }

  const raw = JSON.parse(await readFile(filePath, 'utf8')) as Partial<LmStudioMcpConfig>;
  return {
    mcpServers: typeof raw.mcpServers === 'object' && raw.mcpServers !== null ? raw.mcpServers : {},
  };
};

export const printLmStudioMcpConfig = (rootDir: string): string => {
  return `${JSON.stringify({
    mcpServers: {
      [LM_STUDIO_MCP_SERVER_NAME]: buildLmStudioMcpServerConfig(rootDir),
    },
  }, null, 2)}\n`;
};

export const installLmStudioMcpServer = async (rootDir: string): Promise<string> => {
  const filePath = resolveLmStudioMcpConfigPath();
  const config = await readExistingMcpConfig(filePath);

  for (const legacyName of LEGACY_LM_STUDIO_MCP_SERVER_NAMES) {
    delete config.mcpServers[legacyName];
  }

  config.mcpServers[LM_STUDIO_MCP_SERVER_NAME] = buildLmStudioMcpServerConfig(rootDir);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return filePath;
};