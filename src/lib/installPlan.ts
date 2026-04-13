import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { applyProfileWithOverrides, loadRuntimeConfig, type ProfileName } from './env.js';
import { commandExists, runCommand } from './shell.js';

type NvidiaSmiRow = {
  name: string;
  memoryGiB: number | null;
};

export type HardwareGpu = {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'unknown';
  memoryGiB: number | null;
  source: 'nvidia-smi' | 'win32-video-controller' | 'heuristic' | 'unknown';
};

export type HardwareSnapshot = {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  logicalCores: number;
  systemMemoryGiB: number;
  gpus: HardwareGpu[];
};

export type RecommendedModel = {
  model: string;
  role: 'chat-primary' | 'chat-fallback' | 'tooling' | 'alternate';
  autoAcquire: boolean;
  autoLoad: boolean;
  rationale: string;
};

export type InstallPlan = {
  hardware: HardwareSnapshot;
  selectedProfile: ProfileName;
  bundleId: string;
  bundleLabel: string;
  envOverrides: Record<string, string>;
  recommendedModels: RecommendedModel[];
  openJarvisModel: string;
  openJarvisModelCandidates: string[];
  openClawModel: string;
  openClawModelCandidates: string[];
  hermesModel: string;
  hermesModelCandidates: string[];
  nemoClawModel: string;
  nemoClawModelCandidates: string[];
  nemoClawProvider: string;
  openClawConfigured: boolean;
  hermesAvailable: boolean;
  nemoClawAvailable: boolean;
  notes: string[];
};

const formatCandidatePolicy = (primary: string, candidates: string[]): string => {
  const alternates = candidates.filter((candidate) => candidate !== primary);
  return alternates.length > 0
    ? `${primary} (accepts: ${alternates.join(', ')})`
    : primary;
};

const roundGiB = (bytes: number): number => Math.max(1, Math.round(bytes / (1024 ** 3)));

const inferVendor = (name: string): HardwareGpu['vendor'] => {
  const normalized = name.toLowerCase();
  if (normalized.includes('nvidia') || normalized.includes('geforce') || normalized.includes('rtx')) {
    return 'nvidia';
  }
  if (normalized.includes('amd') || normalized.includes('radeon')) {
    return 'amd';
  }
  if (normalized.includes('intel')) {
    return 'intel';
  }
  return 'unknown';
};

const inferMemoryFromName = (name: string, detectedMemoryGiB: number | null): number | null => {
  const normalized = name.toLowerCase();
  if (normalized.includes('4090')) {
    return 24;
  }
  if (normalized.includes('4080')) {
    return 16;
  }
  if (normalized.includes('4070 ti')) {
    return 12;
  }
  if (normalized.includes('4060 ti')) {
    if ((detectedMemoryGiB ?? 0) >= 12) {
      return 16;
    }
    return 8;
  }
  if (normalized.includes('4060')) {
    return 8;
  }
  if (normalized.includes('3060 ti')) {
    return 8;
  }
  if (normalized.includes('3080')) {
    return detectedMemoryGiB && detectedMemoryGiB > 10 ? 12 : 10;
  }
  if (normalized.includes('3090')) {
    return 24;
  }
  if (normalized.includes('a4000')) {
    return 16;
  }
  return detectedMemoryGiB;
};

const parseNvidiaSmi = (stdout: string): NvidiaSmiRow[] => {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [namePart, memoryPart] = line.split(',').map((item) => item.trim());
      const memory = Number(memoryPart);
      return {
        name: namePart,
        memoryGiB: Number.isFinite(memory) && memory > 0 ? Math.round(memory / 1024) : null,
      };
    })
    .filter((row) => row.name);
};

const detectGpuViaNvidiaSmi = async (rootDir: string): Promise<HardwareGpu[]> => {
  const hasNvidiaSmi = await commandExists('nvidia-smi', rootDir);
  if (!hasNvidiaSmi) {
    return [];
  }

  const result = await runCommand('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], rootDir);
  if (result.code !== 0 || !result.stdout) {
    return [];
  }

  return parseNvidiaSmi(result.stdout).map((row) => ({
    name: row.name,
    vendor: inferVendor(row.name),
    memoryGiB: row.memoryGiB,
    source: 'nvidia-smi',
  }));
};

const detectGpuViaWin32 = async (rootDir: string): Promise<HardwareGpu[]> => {
  if (process.platform !== 'win32') {
    return [];
  }

  const script = 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress';
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script], rootDir);
  if (result.code !== 0 || !result.stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<{ Name?: string; AdapterRAM?: number }> | { Name?: string; AdapterRAM?: number };
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row) => typeof row?.Name === 'string' && row.Name.trim())
      .map((row) => {
        const rawMemory = typeof row.AdapterRAM === 'number' && row.AdapterRAM > 0 ? roundGiB(row.AdapterRAM) : null;
        const inferred = inferMemoryFromName(row.Name ?? '', rawMemory);
        return {
          name: String(row.Name ?? '').trim(),
          vendor: inferVendor(String(row.Name ?? '')),
          memoryGiB: inferred,
          source: 'win32-video-controller' as const,
        };
      });
  } catch {
    return [];
  }
};

const uniqueGpus = (gpus: HardwareGpu[]): HardwareGpu[] => {
  const seen = new Set<string>();
  const deduped: HardwareGpu[] = [];
  for (const gpu of gpus) {
    const key = gpu.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...gpu,
      memoryGiB: inferMemoryFromName(gpu.name, gpu.memoryGiB),
    });
  }
  return deduped;
};

export const detectHardwareSnapshot = async (rootDir: string): Promise<HardwareSnapshot> => {
  const cpuModel = os.cpus()[0]?.model?.trim() || 'unknown';
  const logicalCores = os.cpus().length || 1;
  const systemMemoryGiB = roundGiB(os.totalmem());
  const [nvidiaSmiGpus, win32Gpus] = await Promise.all([
    detectGpuViaNvidiaSmi(rootDir),
    detectGpuViaWin32(rootDir),
  ]);
  const gpus = uniqueGpus([...nvidiaSmiGpus, ...win32Gpus]);

  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel,
    logicalCores,
    systemMemoryGiB,
    gpus,
  };
};

const describeGpus = (snapshot: HardwareSnapshot): string => {
  if (snapshot.gpus.length === 0) {
    return 'no discrete GPU detected';
  }

  return snapshot.gpus
    .map((gpu) => `${gpu.name}${gpu.memoryGiB ? ` ${gpu.memoryGiB}GB` : ''}`)
    .join(', ');
};

const pickPrimaryGpu = (snapshot: HardwareSnapshot): HardwareGpu | null => {
  return snapshot.gpus[0] ?? null;
};

const build4060Ti16Bundle = (
  snapshot: HardwareSnapshot,
  hermesAvailable: boolean,
  openClawConfigured: boolean,
  nemoClawAvailable: boolean,
): InstallPlan => {
  const recommendedModels: RecommendedModel[] = [
    {
      model: 'nemotron-nano-8b',
      role: 'chat-primary',
      autoAcquire: true,
      autoLoad: true,
      rationale: 'Even on 16GB hardware, the packaged teammate path should stay on the stable 8B front door by default so every helper lane sees the same local surface.',
    },
    {
      model: 'qwen2.5-14b-instruct',
      role: 'alternate',
      autoAcquire: false,
      autoLoad: false,
      rationale: 'A 14B option still makes sense on some 16GB machines, but it should stay an explicit alternate instead of redefining the default packaged path.',
    },
    {
      model: 'gemma-4',
      role: 'alternate',
      autoAcquire: false,
      autoLoad: false,
      rationale: 'Gemma can still outperform the default choice on some prompt mixes, so keep it in the candidate list instead of hardcoding one winner.',
    },
  ];
  const recommendedModelCandidates = recommendedModels.map((model) => model.model);
  const autoAcquire = recommendedModels.some((model) => model.autoAcquire);
  const autoLoad = recommendedModels.some((model) => model.autoLoad);

  return {
    hardware: snapshot,
    selectedProfile: '4060ti-8b',
    bundleId: 'auto-4060ti-16g-hybrid',
    bundleLabel: '4060 Ti 16GB hybrid local bundle',
    envOverrides: {
      LM_STUDIO_PROFILE: 'auto-4060ti-16g-hybrid',
      LM_STUDIO_MODEL_HINT: 'nemotron-nano-8b',
      LM_STUDIO_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      LM_STUDIO_AUTO_ACQUIRE_MODELS: autoAcquire ? 'true' : 'false',
      LM_STUDIO_AUTO_LOAD_PRIMARY_MODEL: autoLoad ? 'true' : 'false',
      OPENJARVIS_ENABLED: 'true',
      OPENJARVIS_MODEL_HINT: 'nemotron-nano-8b',
      OPENJARVIS_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_MODEL: 'nemotron-nano-8b',
      OPENCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENABLED: 'true',
      NEMOCLAW_PROVIDER: 'custom',
      NEMOCLAW_MODEL: 'nemotron-nano-8b',
      NEMOCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENDPOINT_URL: 'http://127.0.0.1:1234/v1',
      NEMOCLAW_COMPATIBLE_API_KEY: 'lmstudio-local',
      HERMES_ENABLED: 'true',
      HERMES_MODEL_HINT: 'nemotron-nano-8b',
      HERMES_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
    },
    recommendedModels,
    openJarvisModel: 'nemotron-nano-8b',
    openJarvisModelCandidates: recommendedModelCandidates,
    openClawModel: 'nemotron-nano-8b',
    openClawModelCandidates: recommendedModelCandidates,
    hermesModel: 'nemotron-nano-8b',
    hermesModelCandidates: recommendedModelCandidates,
    nemoClawModel: 'nemotron-nano-8b',
    nemoClawModelCandidates: recommendedModelCandidates,
    nemoClawProvider: 'custom',
    openClawConfigured,
    hermesAvailable,
    nemoClawAvailable,
    notes: [
      `Detected assets: ${describeGpus(snapshot)}; ${snapshot.systemMemoryGiB}GB system RAM.`,
      'This bundle keeps the packaged path on one 8B front door even on stronger hardware, while still surfacing heavier alternates as explicit choices.',
      'n8n remains the experimental orchestration lane; treat it as a convenience layer, not the semantic core.',
    ],
  };
};

const build4060Ti8Bundle = (
  snapshot: HardwareSnapshot,
  hermesAvailable: boolean,
  openClawConfigured: boolean,
  nemoClawAvailable: boolean,
): InstallPlan => {
  const recommendedModels: RecommendedModel[] = [
    {
      model: 'nemotron-nano-8b',
      role: 'chat-primary',
      autoAcquire: true,
      autoLoad: true,
      rationale: 'A 4060 Ti 8GB class machine should start from the stable 8B front door rather than assume a 14B fit.',
    },
    {
      model: 'qwen2.5-7b-instruct',
      role: 'tooling',
      autoAcquire: true,
      autoLoad: false,
      rationale: 'Keeps a second instruct-style model available for OpenJarvis, OpenClaw, or Hermes task routing without overcommitting VRAM.',
    },
    {
      model: 'qwen2.5-14b-instruct',
      role: 'alternate',
      autoAcquire: false,
      autoLoad: false,
      rationale: 'Still worth considering on some 4060 Ti machines, but it should stay an explicit candidate instead of the default load.',
    },
    {
      model: 'gemma-4',
      role: 'alternate',
      autoAcquire: false,
      autoLoad: false,
      rationale: 'Gemma may still end up being the best practical choice for some users, so expose it in the bundle rather than hiding it.',
    },
  ];
  const recommendedModelCandidates = recommendedModels.map((model) => model.model);
  const autoAcquire = recommendedModels.some((model) => model.autoAcquire);
  const autoLoad = recommendedModels.some((model) => model.autoLoad);

  return {
    hardware: snapshot,
    selectedProfile: '4060ti-8b',
    bundleId: 'auto-4060ti-8g-balanced',
    bundleLabel: '4060 Ti balanced 8B bundle',
    envOverrides: {
      LM_STUDIO_PROFILE: 'auto-4060ti-8g-balanced',
      LM_STUDIO_MODEL_HINT: 'nemotron-nano-8b',
      LM_STUDIO_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      LM_STUDIO_AUTO_ACQUIRE_MODELS: autoAcquire ? 'true' : 'false',
      LM_STUDIO_AUTO_LOAD_PRIMARY_MODEL: autoLoad ? 'true' : 'false',
      OPENJARVIS_ENABLED: 'true',
      OPENJARVIS_MODEL_HINT: 'nemotron-nano-8b',
      OPENJARVIS_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_MODEL: 'nemotron-nano-8b',
      OPENCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENABLED: 'true',
      NEMOCLAW_PROVIDER: 'custom',
      NEMOCLAW_MODEL: 'nemotron-nano-8b',
      NEMOCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENDPOINT_URL: 'http://127.0.0.1:1234/v1',
      NEMOCLAW_COMPATIBLE_API_KEY: 'lmstudio-local',
      HERMES_ENABLED: 'true',
      HERMES_MODEL_HINT: 'nemotron-nano-8b',
      HERMES_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
    },
    recommendedModels,
    openJarvisModel: 'nemotron-nano-8b',
    openJarvisModelCandidates: recommendedModelCandidates,
    openClawModel: 'nemotron-nano-8b',
    openClawModelCandidates: recommendedModelCandidates,
    hermesModel: 'nemotron-nano-8b',
    hermesModelCandidates: recommendedModelCandidates,
    nemoClawModel: 'nemotron-nano-8b',
    nemoClawModelCandidates: recommendedModelCandidates,
    nemoClawProvider: 'custom',
    openClawConfigured,
    hermesAvailable,
    nemoClawAvailable,
    notes: [
      `Detected assets: ${describeGpus(snapshot)}; ${snapshot.systemMemoryGiB}GB system RAM.`,
      'This bundle prefers a conservative front-door model, but still records 14B and Gemma candidates so packaged installs do not look single-track.',
      'OpenJarvis, OpenClaw, Hermes, and NemoClaw stay aligned on the same LM Studio front-door model.',
    ],
  };
};

const build3060TiBundle = (
  snapshot: HardwareSnapshot,
  hermesAvailable: boolean,
  openClawConfigured: boolean,
  nemoClawAvailable: boolean,
): InstallPlan => {
  const recommendedModels: RecommendedModel[] = [
    {
      model: 'nemotron-3-nano-30b',
      role: 'chat-primary',
      autoAcquire: false,
      autoLoad: false,
      rationale: 'Keeps the repo’s existing 30B/offload-oriented path for teammates who explicitly want the richest local chat model on a 3060 Ti class machine.',
    },
    {
      model: 'nemotron-nano-8b',
      role: 'chat-fallback',
      autoAcquire: true,
      autoLoad: true,
      rationale: 'Provides the safer first-boot fallback when the 30B path is too heavy or too slow on a given machine.',
    },
    {
      model: 'qwen2.5-7b-instruct',
      role: 'tooling',
      autoAcquire: true,
      autoLoad: false,
      rationale: 'Useful as a helper-lane model for OpenJarvis, OpenClaw, or Hermes while the primary chat choice remains conservative.',
    },
  ];
  const recommendedModelCandidates = recommendedModels.map((model) => model.model);
  const autoAcquire = recommendedModels.some((model) => model.autoAcquire);
  const autoLoad = recommendedModels.some((model) => model.autoLoad);

  return {
    hardware: snapshot,
    selectedProfile: '3060ti-30b',
    bundleId: 'auto-3060ti-offload',
    bundleLabel: '3060 Ti offload-first bundle',
    envOverrides: {
      LM_STUDIO_PROFILE: 'auto-3060ti-offload',
      LM_STUDIO_MODEL_HINT: 'nemotron-nano-8b',
      LM_STUDIO_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      LM_STUDIO_AUTO_ACQUIRE_MODELS: autoAcquire ? 'true' : 'false',
      LM_STUDIO_AUTO_LOAD_PRIMARY_MODEL: autoLoad ? 'true' : 'false',
      OPENJARVIS_ENABLED: 'true',
      OPENJARVIS_MODEL_HINT: 'nemotron-nano-8b',
      OPENJARVIS_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_MODEL: 'nemotron-nano-8b',
      OPENCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENABLED: 'true',
      NEMOCLAW_PROVIDER: 'custom',
      NEMOCLAW_MODEL: 'nemotron-nano-8b',
      NEMOCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENDPOINT_URL: 'http://127.0.0.1:1234/v1',
      NEMOCLAW_COMPATIBLE_API_KEY: 'lmstudio-local',
      HERMES_ENABLED: 'true',
      HERMES_MODEL_HINT: 'nemotron-nano-8b',
      HERMES_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
    },
    recommendedModels,
    openJarvisModel: 'nemotron-nano-8b',
    openJarvisModelCandidates: recommendedModelCandidates,
    openClawModel: 'nemotron-nano-8b',
    openClawModelCandidates: recommendedModelCandidates,
    hermesModel: 'nemotron-nano-8b',
    hermesModelCandidates: recommendedModelCandidates,
    nemoClawModel: 'nemotron-nano-8b',
    nemoClawModelCandidates: recommendedModelCandidates,
    nemoClawProvider: 'custom',
    openClawConfigured,
    hermesAvailable,
    nemoClawAvailable,
    notes: [
      `Detected assets: ${describeGpus(snapshot)}; ${snapshot.systemMemoryGiB}GB system RAM.`,
      'The package keeps the historical 30B profile available, but installs should still default to an 8B front door unless the teammate explicitly accepts the offload tradeoff.',
      'OpenJarvis, OpenClaw, Hermes, and NemoClaw stay aligned to the same 8B LM Studio surface in the default packaged path.',
    ],
  };
};

const buildGenericBundle = (
  snapshot: HardwareSnapshot,
  hermesAvailable: boolean,
  openClawConfigured: boolean,
  nemoClawAvailable: boolean,
): InstallPlan => {
  const recommendedModels: RecommendedModel[] = [
    {
      model: 'nemotron-nano-8b',
      role: 'chat-primary',
      autoAcquire: true,
      autoLoad: true,
      rationale: 'The generic local-first fallback remains the safest default when the machine does not match the curated NVIDIA profiles.',
    },
    {
      model: 'qwen2.5-7b-instruct',
      role: 'tooling',
      autoAcquire: true,
      autoLoad: false,
      rationale: 'Provides a second instruct-style option for the packaged runtime chain without assuming high VRAM.',
    },
  ];
  const recommendedModelCandidates = recommendedModels.map((model) => model.model);
  const autoAcquire = recommendedModels.some((model) => model.autoAcquire);
  const autoLoad = recommendedModels.some((model) => model.autoLoad);

  return {
    hardware: snapshot,
    selectedProfile: '4060ti-8b',
    bundleId: 'auto-generic-local',
    bundleLabel: 'generic local-first bundle',
    envOverrides: {
      LM_STUDIO_PROFILE: 'auto-generic-local',
      LM_STUDIO_MODEL_HINT: 'nemotron-nano-8b',
      LM_STUDIO_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      LM_STUDIO_AUTO_ACQUIRE_MODELS: autoAcquire ? 'true' : 'false',
      LM_STUDIO_AUTO_LOAD_PRIMARY_MODEL: autoLoad ? 'true' : 'false',
      OPENJARVIS_ENABLED: 'true',
      OPENJARVIS_MODEL_HINT: 'nemotron-nano-8b',
      OPENJARVIS_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_MODEL: 'nemotron-nano-8b',
      OPENCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENABLED: 'true',
      NEMOCLAW_PROVIDER: 'custom',
      NEMOCLAW_MODEL: 'nemotron-nano-8b',
      NEMOCLAW_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
      NEMOCLAW_ENDPOINT_URL: 'http://127.0.0.1:1234/v1',
      NEMOCLAW_COMPATIBLE_API_KEY: 'lmstudio-local',
      HERMES_ENABLED: 'true',
      HERMES_MODEL_HINT: 'nemotron-nano-8b',
      HERMES_MODEL_CANDIDATES: recommendedModelCandidates.join(','),
    },
    recommendedModels,
    openJarvisModel: 'nemotron-nano-8b',
    openJarvisModelCandidates: recommendedModelCandidates,
    openClawModel: 'nemotron-nano-8b',
    openClawModelCandidates: recommendedModelCandidates,
    hermesModel: 'nemotron-nano-8b',
    hermesModelCandidates: recommendedModelCandidates,
    nemoClawModel: 'nemotron-nano-8b',
    nemoClawModelCandidates: recommendedModelCandidates,
    nemoClawProvider: 'custom',
    openClawConfigured,
    hermesAvailable,
    nemoClawAvailable,
    notes: [
      `Detected assets: ${describeGpus(snapshot)}; ${snapshot.systemMemoryGiB}GB system RAM.`,
      'No curated GPU profile matched cleanly, so the package falls back to the lighter local bundle instead of pretending it knows the best heavy model.',
      'OpenJarvis, OpenClaw, Hermes, and NemoClaw default to the same LM Studio 8B surface so the packaged stack stays coherent on mixed hardware.',
    ],
  };
};

export const buildInstallPlan = async (rootDir: string): Promise<InstallPlan> => {
  const snapshot = await detectHardwareSnapshot(rootDir);
  const primaryGpu = pickPrimaryGpu(snapshot);
  const config = await loadRuntimeConfig(rootDir);
  const hermesAvailable = await commandExists(config.hermesCommand, rootDir);
  const nemoClawAvailable = await commandExists(config.nemoClawCommand, rootDir);
  const openClawConfigured = Boolean(config.openClawBaseUrl.trim());

  if (primaryGpu && /3060\s*ti/iu.test(primaryGpu.name)) {
    return build3060TiBundle(snapshot, hermesAvailable, openClawConfigured, nemoClawAvailable);
  }

  if (primaryGpu && /4060\s*ti/iu.test(primaryGpu.name) && (primaryGpu.memoryGiB ?? 0) >= 12) {
    return build4060Ti16Bundle(snapshot, hermesAvailable, openClawConfigured, nemoClawAvailable);
  }

  if (primaryGpu && /4060\s*ti/iu.test(primaryGpu.name)) {
    return build4060Ti8Bundle(snapshot, hermesAvailable, openClawConfigured, nemoClawAvailable);
  }

  return buildGenericBundle(snapshot, hermesAvailable, openClawConfigured, nemoClawAvailable);
};

export const resolveInstallPlanPath = (rootDir: string): string => {
  return path.join(rootDir, '.runtime', 'install-plan.json');
};

export const persistInstallPlan = async (rootDir: string, plan: InstallPlan): Promise<string> => {
  const filePath = resolveInstallPlanPath(rootDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return filePath;
};

export const applyInstallPlan = async (rootDir: string, plan: InstallPlan): Promise<string> => {
  return applyProfileWithOverrides(rootDir, plan.selectedProfile, plan.envOverrides);
};

export const formatInstallPlanReport = (plan: InstallPlan): string => {
  const modelLines = plan.recommendedModels.map((model) => {
    const automation = [model.autoAcquire ? 'acquire' : null, model.autoLoad ? 'load' : null]
      .filter(Boolean)
      .join('/');
    return `- ${model.role}: ${model.model}${automation ? ` (${automation})` : ''} - ${model.rationale}`;
  });

  return [
    `auto bundle: ${plan.bundleLabel}`,
    `base profile: ${plan.selectedProfile}`,
    `hardware: ${describeGpus(plan.hardware)}; ${plan.hardware.systemMemoryGiB}GB RAM; ${plan.hardware.logicalCores} logical cores`,
    `openjarvis model policy: ${formatCandidatePolicy(plan.openJarvisModel, plan.openJarvisModelCandidates)}`,
    `openclaw model policy: ${formatCandidatePolicy(plan.openClawModel, plan.openClawModelCandidates)}${plan.openClawConfigured ? ' (gateway configured)' : ' (required gateway will be provisioned)'}`,
    `hermes model policy: ${formatCandidatePolicy(plan.hermesModel, plan.hermesModelCandidates)}${plan.hermesAvailable ? ' (runtime already present)' : ' (required runtime will be provisioned)'}`,
    `nemoclaw model policy: ${formatCandidatePolicy(plan.nemoClawModel, plan.nemoClawModelCandidates)} via ${plan.nemoClawProvider}${plan.nemoClawAvailable ? ' (runtime already present)' : ' (official onboard will provision it)'}`,
    ...modelLines,
    ...plan.notes.map((note) => `note: ${note}`),
  ].join('\n');
};