import path from 'node:path';
import { applyProfile, loadRuntimeConfig, type ProfileName, type RuntimeConfig } from './env.js';
import { buildChatSdkSummary, checkChatSdk } from './chatSdk.js';
import { ensureLmStudio, type ServiceStatus } from './lmStudio.js';
import { checkN8n, checkOpenJarvis, ensureN8n, ensureNemoClaw, ensureOpenJarvis } from './services.js';
import { generateToolSurface } from './workflows.js';

export type DoctorReport = {
  profile: string;
  generatedWorkflows: number;
  statuses: Record<string, ServiceStatus>;
};

const serviceLine = (name: string, status: ServiceStatus): string => {
  const prefix = status.ok ? '[ok]' : '[warn]';
  return `${prefix} ${name}: ${status.detail}`;
};

export const formatDoctorReport = (report: DoctorReport): string => {
  return [
    `profile: ${report.profile}`,
    `generated workflows: ${report.generatedWorkflows}`,
    serviceLine('lmstudio', report.statuses.lmstudio),
    serviceLine('n8n', report.statuses.n8n),
    serviceLine('openjarvis', report.statuses.openjarvis),
    serviceLine('nemoclaw', report.statuses.nemoclaw),
    serviceLine('chat-sdk', report.statuses.chatsdk),
  ].join('\n');
};

export const runDoctor = async (config: RuntimeConfig, generatedWorkflows = 0): Promise<DoctorReport> => {
  const [lmstudio, n8n, openjarvis, nemoclaw, chatsdk] = await Promise.all([
    ensureLmStudio(config),
    checkN8n(config),
    checkOpenJarvis(config),
    ensureNemoClaw(config),
    checkChatSdk(config),
  ]);

  return {
    profile: config.lmStudioProfile,
    generatedWorkflows,
    statuses: { lmstudio, n8n, openjarvis, nemoclaw, chatsdk },
  };
};

export const runBootstrap = async (rootDir: string, profile: ProfileName): Promise<DoctorReport> => {
  await applyProfile(rootDir, profile);
  const config = await loadRuntimeConfig(rootDir);
  const generated = await generateToolSurface(config);
  const [lmstudio, n8n, openjarvis, nemoclaw, chatsdk] = await Promise.all([
    ensureLmStudio(config),
    ensureN8n(config),
    ensureOpenJarvis(config),
    ensureNemoClaw(config),
    checkChatSdk(config),
  ]);

  return {
    profile: config.lmStudioProfile,
    generatedWorkflows: generated.length,
    statuses: { lmstudio, n8n, openjarvis, nemoclaw, chatsdk },
  };
};

export const runApplyProfile = async (rootDir: string, profile: ProfileName): Promise<string> => {
  return applyProfile(rootDir, profile);
};

export const runGenerateToolSurface = async (rootDir: string): Promise<string[]> => {
  const config = await loadRuntimeConfig(rootDir);
  return generateToolSurface(config);
};

export const runStartOpenJarvis = async (rootDir: string): Promise<ServiceStatus> => {
  const config = await loadRuntimeConfig(rootDir);
  return ensureOpenJarvis(config);
};

export const runStartOptionalLanes = async (rootDir: string): Promise<Record<string, ServiceStatus>> => {
  const config = await loadRuntimeConfig(rootDir);
  const [openjarvis, nemoclaw, chatsdk] = await Promise.all([
    ensureOpenJarvis(config),
    ensureNemoClaw(config),
    checkChatSdk(config),
  ]);
  return { openjarvis, nemoclaw, chatsdk };
};

export const formatOptionalLaneReport = (statuses: Record<string, ServiceStatus>): string => {
  return [
    serviceLine('openjarvis', statuses.openjarvis),
    serviceLine('nemoclaw', statuses.nemoclaw),
    serviceLine('chat-sdk', statuses.chatsdk),
  ].join('\n');
};

export const runChatSdkSummary = async (rootDir: string): Promise<string[]> => {
  const config = await loadRuntimeConfig(rootDir);
  return buildChatSdkSummary(config);
};

export const runStartN8n = async (rootDir: string): Promise<ServiceStatus> => {
  const config = await loadRuntimeConfig(rootDir);
  await ensureN8n(config);
  return checkN8n(config);
};

export const defaultRootDir = (): string => path.resolve(process.cwd());
