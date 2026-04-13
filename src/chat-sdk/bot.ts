import { Chat } from 'chat';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createGitHubAdapter } from '@chat-adapter/github';
import { createMemoryState } from '@chat-adapter/state-memory';

type SupportedAdapter = 'discord' | 'github';

const parseRequestedAdapters = (value: string | undefined): Set<SupportedAdapter> => {
  const requested = new Set<SupportedAdapter>();
  for (const item of String(value || 'discord,github').split(',')) {
    const normalized = item.trim().toLowerCase();
    if (normalized === 'discord' || normalized === 'github') {
      requested.add(normalized);
    }
  }
  return requested;
};

const requestedAdapters = parseRequestedAdapters(process.env.CHAT_SDK_ADAPTERS);

const adapters: Record<string, ReturnType<typeof createDiscordAdapter> | ReturnType<typeof createGitHubAdapter>> = {};
if (requestedAdapters.has('discord')) {
  adapters.discord = createDiscordAdapter();
}
if (requestedAdapters.has('github')) {
  adapters.github = createGitHubAdapter();
}

if (Object.keys(adapters).length === 0) {
  throw new Error('No supported Chat SDK adapters requested. Use CHAT_SDK_ADAPTERS=discord,github.');
}

const intro = [
  'Local Super-Agent ingress is alive.',
  'This starter keeps LM Studio local, n8n deterministic, and OpenJarvis or NemoClaw optional.',
  'Keep the ingress thin and route durable automation into your local runtime surfaces.',
].join(' ');

export const bot = new Chat({
  userName: process.env.CHAT_SDK_USER_NAME || 'local-super-agent',
  adapters,
  state: createMemoryState(),
  logger: 'info',
});

bot.onNewMention(async (thread) => {
  await thread.subscribe();
  await thread.post(intro);
});

bot.onSubscribedMessage(async (thread, message) => {
  const incomingText = typeof message.text === 'string' ? message.text.trim() : '';
  if (/status|doctor|health/i.test(incomingText)) {
    await thread.post('Run npm run doctor locally to inspect LM Studio, n8n, OpenJarvis, NemoClaw, and Chat SDK readiness.');
    return;
  }

  await thread.post('Ingress skeleton reached this thread. Connect this handler to your local automation or agent runtime next.');
});