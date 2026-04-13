import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type LedgerMessage = {
  direction: 'incoming' | 'outgoing' | 'system';
  actor: string;
  text: string;
  at: string;
};

export type ThreadLedgerRecord = {
  threadId: string;
  adapter: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  recentMessages: LedgerMessage[];
};

const MAX_RECENT_MESSAGES = 12;

const normalizeText = (value: unknown): string => {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
};

const sanitizeFileComponent = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 80) || 'thread';
};

const extractThreadId = (thread: Record<string, unknown>, message?: Record<string, unknown>): string => {
  const candidates = [thread.id, thread.threadId, thread.key, message?.threadId, message?.threadKey]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  return candidates[0] ?? 'unknown-thread';
};

const extractAdapter = (thread: Record<string, unknown>, message?: Record<string, unknown>): string => {
  const candidates = [thread.adapter, thread.adapterId, message?.adapter]
    .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
    .filter(Boolean);
  return candidates[0] ?? 'unknown-adapter';
};

const extractActor = (message: Record<string, unknown> | undefined, fallback: string): string => {
  if (!message) {
    return fallback;
  }

  const direct = typeof message.author === 'string' ? message.author : undefined;
  if (direct?.trim()) {
    return direct.trim();
  }

  const user = typeof message.user === 'string' ? message.user : undefined;
  if (user?.trim()) {
    return user.trim();
  }

  const nestedUser = message.user && typeof message.user === 'object'
    ? (message.user as Record<string, unknown>).name
    : undefined;
  if (typeof nestedUser === 'string' && nestedUser.trim()) {
    return nestedUser.trim();
  }

  return fallback;
};

const resolveLedgerDir = (): string => {
  const configured = process.env.CHAT_SDK_LEDGER_DIR || path.join('.runtime', 'chat-sdk');
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
};

const readLedgerRecord = async (filePath: string): Promise<ThreadLedgerRecord | null> => {
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as ThreadLedgerRecord;
};

const writeLedgerRecord = async (filePath: string, record: ThreadLedgerRecord): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
};

const buildFilePath = (ledgerDir: string, threadId: string): string => {
  return path.join(ledgerDir, 'threads', `${sanitizeFileComponent(threadId)}.json`);
};

const applyMessage = (
  existing: ThreadLedgerRecord | null,
  threadId: string,
  adapter: string,
  message: LedgerMessage,
): ThreadLedgerRecord => {
  const base: ThreadLedgerRecord = existing ?? {
    threadId,
    adapter,
    createdAt: message.at,
    updatedAt: message.at,
    messageCount: 0,
    recentMessages: [],
  };

  return {
    ...base,
    adapter,
    updatedAt: message.at,
    messageCount: base.messageCount + 1,
    recentMessages: [...base.recentMessages, message].slice(-MAX_RECENT_MESSAGES),
  };
};

export const createDurableChatLedger = () => {
  const ledgerDir = resolveLedgerDir();

  const record = async (
    threadLike: unknown,
    direction: LedgerMessage['direction'],
    text: string,
    messageLike?: unknown,
  ): Promise<ThreadLedgerRecord> => {
    const thread = (threadLike && typeof threadLike === 'object' ? threadLike : {}) as Record<string, unknown>;
    const message = (messageLike && typeof messageLike === 'object' ? messageLike : undefined) as Record<string, unknown> | undefined;
    const threadId = extractThreadId(thread, message);
    const adapter = extractAdapter(thread, message);
    const filePath = buildFilePath(ledgerDir, threadId);
    const current = await readLedgerRecord(filePath);
    const next = applyMessage(current, threadId, adapter, {
      direction,
      actor: extractActor(message, direction === 'outgoing' ? 'local-super-agent' : 'user'),
      text: normalizeText(text),
      at: new Date().toISOString(),
    });
    await writeLedgerRecord(filePath, next);
    return next;
  };

  const peek = async (threadLike: unknown, messageLike?: unknown): Promise<ThreadLedgerRecord | null> => {
    const thread = (threadLike && typeof threadLike === 'object' ? threadLike : {}) as Record<string, unknown>;
    const message = (messageLike && typeof messageLike === 'object' ? messageLike : undefined) as Record<string, unknown> | undefined;
    const threadId = extractThreadId(thread, message);
    return readLedgerRecord(buildFilePath(ledgerDir, threadId));
  };

  return {
    ledgerDir,
    peek,
    recordIncoming: async (threadLike: unknown, messageLike: unknown) => {
      const text = normalizeText((messageLike as Record<string, unknown> | undefined)?.text);
      return record(threadLike, 'incoming', text, messageLike);
    },
    recordOutgoing: async (threadLike: unknown, text: string) => {
      return record(threadLike, 'outgoing', text);
    },
    recordSystem: async (threadLike: unknown, text: string) => {
      return record(threadLike, 'system', text);
    },
  };
};