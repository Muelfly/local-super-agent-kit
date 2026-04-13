#!/usr/bin/env node
import { defaultRootDir, formatDoctorReport, formatOptionalLaneReport, runApplyProfile, runBootstrap, runChatSdkSummary, runDoctor, runGenerateToolSurface, runStartControlPlane, runStartN8n, runStartOpenJarvis, runStartOptionalLanes } from './lib/bootstrap.js';
import { serveControlPlane } from './lib/controlPlane.js';
import { loadRuntimeConfig, type ProfileName } from './lib/env.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'doctor';

const readOption = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
};

const isProfileName = (value: string | undefined): value is ProfileName => {
  return value === '4060ti-8b' || value === '3060ti-30b';
};

const fail = (message: string): never => {
  throw new Error(message);
};

const main = async (): Promise<void> => {
  const rootDir = defaultRootDir();

  switch (command) {
    case 'bootstrap': {
      const profileArg = readOption('--profile') ?? '4060ti-8b';
      const profile = isProfileName(profileArg) ? profileArg : fail(`Unknown profile: ${profileArg}`);
      const report = await runBootstrap(rootDir, profile);
      console.log(formatDoctorReport(report));
      if (!report.statuses.lmstudio.ok || !report.statuses.n8n.ok || !report.statuses.controlplane.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'apply-profile': {
      const profileArg = readOption('--profile') ?? '4060ti-8b';
      const profile = isProfileName(profileArg) ? profileArg : fail(`Unknown profile: ${profileArg}`);
      const target = await runApplyProfile(rootDir, profile);
      console.log(`profile applied: ${profile}`);
      console.log(`wrote: ${target}`);
      return;
    }

    case 'generate-tool-surface': {
      const written = await runGenerateToolSurface(rootDir);
      console.log(`generated workflows: ${written.length}`);
      for (const filePath of written) {
        console.log(filePath);
      }
      return;
    }

    case 'start-n8n': {
      const status = await runStartN8n(rootDir);
      console.log(`n8n: ${status.detail}`);
      if (!status.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'start-control-plane': {
      const status = await runStartControlPlane(rootDir);
      console.log(`control-plane: ${status.detail}`);
      if (!status.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'serve-control-plane': {
      const config = await loadRuntimeConfig(rootDir);
      const server = await serveControlPlane(config);
      console.log(`control-plane listening on ${config.controlPlaneBaseUrl}`);
      await new Promise<void>((resolve, reject) => {
        server.once('close', () => resolve());
        server.once('error', reject);
      });
      return;
    }

    case 'start-openjarvis': {
      const status = await runStartOpenJarvis(rootDir);
      console.log(`openjarvis: ${status.detail}`);
      if (!status.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'start-optional-lanes': {
      const statuses = await runStartOptionalLanes(rootDir);
      console.log(formatOptionalLaneReport(statuses));
      if (!statuses.openjarvis.ok || !statuses.nemoclaw.ok || !statuses.chatsdk.ok) {
        process.exitCode = 1;
      }
      return;
    }

    case 'chat-sdk-summary': {
      const lines = await runChatSdkSummary(rootDir);
      console.log(lines.join('\n'));
      return;
    }

    case 'doctor': {
      const config = await loadRuntimeConfig(rootDir);
      const report = await runDoctor(config);
      console.log(formatDoctorReport(report));
      if (!report.statuses.lmstudio.ok || !report.statuses.n8n.ok || !report.statuses.controlplane.ok) {
        process.exitCode = 1;
      }
      return;
    }

    default:
      fail(`Unknown command: ${command}`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
