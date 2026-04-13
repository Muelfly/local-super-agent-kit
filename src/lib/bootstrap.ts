import path from 'node:path';
import { applyProfile, loadRuntimeConfig, type ProfileName, type RuntimeConfig } from './env.js';
import { buildChatSdkSummary, checkChatSdk } from './chatSdk.js';
import { promoteWorkflowBundleToN8n } from './controlPlane.js';
import { ensureLmStudio, ensureLmStudioModelBundle, type ServiceStatus } from './lmStudio.js';
import { applyInstallPlan, buildInstallPlan, formatInstallPlanReport, persistInstallPlan, type InstallPlan } from './installPlan.js';
import { installLmStudioMcpServer } from './lmstudioMcp.js';
import {
  checkControlPlane,
  checkHermes,
  checkN8n,
  checkNemoClaw,
  checkOpenClaw,
  checkOpenJarvis,
  ensureControlPlane,
  ensureHermes,
  ensureN8n,
  ensureNemoClaw,
  ensureOpenClaw,
  ensureOpenJarvis,
} from './services.js';
import { generateToolSurface, readMergedToolSurface } from './workflows.js';

export type DoctorReport = {
  profile: string;
  generatedWorkflows: number;
  promotedWorkflows: number;
  statuses: Record<string, ServiceStatus>;
  installPlan?: InstallPlan;
  installPlanPath?: string;
  envTargetPath?: string;
  modelBundleStatus?: ServiceStatus;
};

const serviceLine = (name: string, status: ServiceStatus): string => {
  const prefix = status.ok ? '[ok]' : '[warn]';
  return `${prefix} ${name}: ${status.detail}`;
};

export const formatDoctorReport = (report: DoctorReport): string => {
  return [
    report.installPlan ? formatInstallPlanReport(report.installPlan) : null,
    report.envTargetPath ? `env target: ${report.envTargetPath}` : null,
    report.installPlanPath ? `install plan file: ${report.installPlanPath}` : null,
    `profile: ${report.profile}`,
    `generated workflows: ${report.generatedWorkflows}`,
    `promoted workflows: ${report.promotedWorkflows}`,
    serviceLine('lmstudio', report.statuses.lmstudio),
    report.modelBundleStatus ? serviceLine('lmstudio-bundle', report.modelBundleStatus) : null,
    serviceLine('n8n', report.statuses.n8n),
    serviceLine('control-plane', report.statuses.controlplane),
    serviceLine('openjarvis', report.statuses.openjarvis),
    serviceLine('openclaw', report.statuses.openclaw),
    serviceLine('nemoclaw', report.statuses.nemoclaw),
    serviceLine('hermes', report.statuses.hermes),
    serviceLine('chat-sdk', report.statuses.chatsdk),
  ].filter(Boolean).join('\n');
};

export const runDoctor = async (
  config: RuntimeConfig,
  generatedWorkflows = 0,
  promotedWorkflows = 0,
): Promise<DoctorReport> => {
  const surface = await readMergedToolSurface(config);
  const [lmstudio, n8n, controlplane, openjarvis, openclaw, nemoclaw, hermes, chatsdk] = await Promise.all([
    ensureLmStudio(config),
    checkN8n(config),
    checkControlPlane(config),
    checkOpenJarvis(config),
    checkOpenClaw(config),
    checkNemoClaw(config),
    checkHermes(config),
    checkChatSdk(config),
  ]);

  return {
    profile: config.lmStudioProfile,
    generatedWorkflows: generatedWorkflows || surface.tools.length,
    promotedWorkflows,
    statuses: { lmstudio, n8n, controlplane, openjarvis, openclaw, nemoclaw, hermes, chatsdk },
  };
};

export const runBootstrap = async (rootDir: string, profile: ProfileName): Promise<DoctorReport> => {
  await applyProfile(rootDir, profile);
  await installLmStudioMcpServer(rootDir);
  const config = await loadRuntimeConfig(rootDir);
  const generated = await generateToolSurface(config);
  const [lmstudio, modelBundleStatus, n8n, controlplane, openjarvis, openclaw, nemoclaw, hermes, chatsdk] = await Promise.all([
    ensureLmStudio(config),
    ensureLmStudioModelBundle(config),
    ensureN8n(config),
    ensureControlPlane(config),
    ensureOpenJarvis(config),
    ensureOpenClaw(config),
    ensureNemoClaw(config),
    ensureHermes(config),
    checkChatSdk(config),
  ]);
  const promotionReports = n8n.ok ? await promoteWorkflowBundleToN8n(config, generated) : [];
  const promotedWorkflows = promotionReports.filter((report) => report.status === 'imported').length;

  return {
    profile: config.lmStudioProfile,
    generatedWorkflows: generated.length,
    promotedWorkflows,
    statuses: { lmstudio, n8n, controlplane, openjarvis, openclaw, nemoclaw, hermes, chatsdk },
    modelBundleStatus,
  };
};

export const runBootstrapAuto = async (rootDir: string): Promise<DoctorReport> => {
  const installPlan = await buildInstallPlan(rootDir);
  const installPlanPath = await persistInstallPlan(rootDir, installPlan);
  const envTargetPath = await applyInstallPlan(rootDir, installPlan);
  await installLmStudioMcpServer(rootDir);
  const config = await loadRuntimeConfig(rootDir);
  const generated = await generateToolSurface(config);
  const [lmstudio, modelBundleStatus, n8n, controlplane, openjarvis, openclaw, nemoclaw, hermes, chatsdk] = await Promise.all([
    ensureLmStudio(config),
    ensureLmStudioModelBundle(config),
    ensureN8n(config),
    ensureControlPlane(config),
    ensureOpenJarvis(config),
    ensureOpenClaw(config),
    ensureNemoClaw(config),
    ensureHermes(config),
    checkChatSdk(config),
  ]);
  const promotionReports = n8n.ok ? await promoteWorkflowBundleToN8n(config, generated) : [];
  const promotedWorkflows = promotionReports.filter((report) => report.status === 'imported').length;

  return {
    profile: config.lmStudioProfile,
    generatedWorkflows: generated.length,
    promotedWorkflows,
    statuses: { lmstudio, n8n, controlplane, openjarvis, openclaw, nemoclaw, hermes, chatsdk },
    installPlan,
    installPlanPath,
    envTargetPath,
    modelBundleStatus,
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

export const runStartControlPlane = async (rootDir: string): Promise<ServiceStatus> => {
  const config = await loadRuntimeConfig(rootDir);
  return ensureControlPlane(config);
};

export const runInstallLmStudioMcp = async (rootDir: string): Promise<string> => {
  return installLmStudioMcpServer(rootDir);
};

export const runStartOptionalLanes = async (rootDir: string): Promise<Record<string, ServiceStatus>> => {
  const config = await loadRuntimeConfig(rootDir);
  const [openjarvis, openclaw, nemoclaw, hermes, chatsdk] = await Promise.all([
    ensureOpenJarvis(config),
    ensureOpenClaw(config),
    ensureNemoClaw(config),
    ensureHermes(config),
    checkChatSdk(config),
  ]);
  return { openjarvis, openclaw, nemoclaw, hermes, chatsdk };
};

export const formatOptionalLaneReport = (statuses: Record<string, ServiceStatus>): string => {
  return [
    serviceLine('openjarvis', statuses.openjarvis),
    serviceLine('openclaw', statuses.openclaw),
    serviceLine('nemoclaw', statuses.nemoclaw),
    serviceLine('hermes', statuses.hermes),
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
