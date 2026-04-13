import type { RuntimeConfig } from './env.js';
import type { ServiceStatus } from './lmStudio.js';

const SUPPORTED_CHAT_SDK_ADAPTERS = ['discord', 'github'] as const;

export type SupportedChatSdkAdapter = (typeof SUPPORTED_CHAT_SDK_ADAPTERS)[number];

const toSupportedAdapter = (value: string): SupportedChatSdkAdapter | null => {
  const normalized = value.trim().toLowerCase();
  return (SUPPORTED_CHAT_SDK_ADAPTERS as readonly string[]).includes(normalized)
    ? normalized as SupportedChatSdkAdapter
    : null;
};

export const resolveChatSdkAdapters = (config: RuntimeConfig): SupportedChatSdkAdapter[] => {
  const adapters = config.chatSdkAdapters
    .map((value) => toSupportedAdapter(value))
    .filter((value): value is SupportedChatSdkAdapter => value !== null);

  return [...new Set(adapters)];
};

export const checkChatSdk = async (config: RuntimeConfig): Promise<ServiceStatus> => {
  if (!config.chatSdkEnabled) {
    return { ok: true, detail: 'disabled' };
  }

  const adapters = resolveChatSdkAdapters(config);
  if (adapters.length === 0) {
    return {
      ok: false,
      detail: 'enabled, but no supported adapters are configured. Use CHAT_SDK_ADAPTERS=discord,github.',
    };
  }

  return {
    ok: true,
    detail: `skeleton ready (${adapters.join(', ')}). Wire src/chat-sdk/bot.ts into your framework and fill adapter credentials locally.`,
  };
};

export const buildChatSdkSummary = (config: RuntimeConfig): string[] => {
  const adapters = resolveChatSdkAdapters(config);
  return [
    `chat-sdk enabled: ${config.chatSdkEnabled}`,
    `chat-sdk user: ${config.chatSdkUserName}`,
    `chat-sdk adapters: ${adapters.length > 0 ? adapters.join(', ') : 'none'}`,
    'chat-sdk entrypoint: src/chat-sdk/bot.ts',
    'chat-sdk state adapter: @chat-adapter/state-memory',
    'next step: mount bot.webhooks.<adapter> inside your HTTP framework routes and connect handlers to local automation.',
  ];
};