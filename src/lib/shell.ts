import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

type CommandEnvironment = Record<string, string | undefined>;

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const quoteCmdArg = (value: string): string => {
  if (value === '') {
    return '""';
  }

  if (!/[\s"&()^<>|]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/gu, '""')}"`;
};

export const runCommand = async (
  command: string,
  args: string[],
  cwd: string,
  environment: CommandEnvironment = {},
): Promise<CommandResult> => {
  return new Promise((resolve, reject) => {
    const isWindowsShellScript = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
    const spawnCommand = isWindowsShellScript ? 'cmd.exe' : command;
    const spawnArgs = isWindowsShellScript
      ? ['/d', '/s', '/c', [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ')]
      : args;

    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: {
        ...process.env,
        ...environment,
      },
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
};

export const runShellCommand = async (
  commandLine: string,
  cwd: string,
  environment: CommandEnvironment = {},
): Promise<CommandResult> => {
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', commandLine] : ['-lc', commandLine];
  return runCommand(shell, args, cwd, environment);
};

export const commandExists = async (command: string, cwd: string): Promise<boolean> => {
  if (path.isAbsolute(command) || command.includes('\\') || command.includes('/')) {
    return existsSync(command);
  }

  const probe = process.platform === 'win32'
    ? await runShellCommand(`where ${command}`, cwd)
    : await runShellCommand(`command -v ${command}`, cwd);
  return probe.code === 0;
};

export const launchDetached = async (command: string, args: string[], cwd: string): Promise<void> => {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
};

export const launchDetachedShell = async (commandLine: string, cwd: string): Promise<void> => {
  if (process.platform === 'win32') {
    await launchDetached('cmd.exe', ['/d', '/s', '/c', commandLine], cwd);
    return;
  }
  await launchDetached('sh', ['-lc', commandLine], cwd);
};
