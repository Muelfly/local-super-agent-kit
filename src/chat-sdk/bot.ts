import { Chat } from 'chat';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createGitHubAdapter } from '@chat-adapter/github';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createDurableChatLedger } from './ledger.js';

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

const ledger = createDurableChatLedger();

const postAndRecord = async (thread: { post: (text: string) => Promise<unknown> }, text: string): Promise<void> => {
  await thread.post(text);
  await ledger.recordOutgoing(thread, text);
};

export const bot = new Chat({
  userName: process.env.CHAT_SDK_USER_NAME || 'local-super-agent',
  adapters,
  state: createMemoryState(),
  logger: 'info',
});

bot.onNewMention(async (thread) => {
  const existing = await ledger.peek(thread);
  await ledger.recordSystem(thread, 'thread mentioned');
  await thread.subscribe();
  const recovered = existing && existing.messageCount > 0
    ? ` Durable context restored with ${existing.messageCount} stored entries.`
    : '';
  await postAndRecord(thread, `${intro}${recovered}`);
});

bot.onSubscribedMessage(async (thread, message) => {
  const incomingText = typeof message.text === 'string' ? message.text.trim() : '';
  const snapshot = await ledger.recordIncoming(thread, message);
  if (/status|doctor|health/i.test(incomingText)) {
    await postAndRecord(
      thread,
      `Run npm run doctor locally to inspect LM Studio, n8n, control-plane, OpenJarvis, NemoClaw, and Chat SDK readiness. Durable ledger entries: ${snapshot.messageCount}.`,
    );
    return;
  }

  if (/resume|memory|context/i.test(incomingText)) {
    const preview = snapshot.recentMessages
      .slice(-3)
      .map((entry) => `${entry.direction}:${entry.actor}:${entry.text}`)
      .join(' | ');
    await postAndRecord(
      thread,
      preview
        ? `Durable thread context is active. Recent entries: ${preview}`
        : 'Durable thread context is active, but there are no stored entries yet.',
    );
    return;
  }

  await postAndRecord(
    thread,
    'Ingress skeleton reached this thread. Durable state is active; connect this handler to your local automation or control-plane runtime next.',
  );
});