import 'server-only';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after } from 'next/server';
import { prisma } from './db';
import { DOCS_DIR } from './news';

// Web Push - системные уведомления браузера/ОС, когда вкладка закрыта (SSE
// работает только при открытом соединении).
//
// Ключи VAPID здесь только читаются, но не генерируются: подписки браузеров
// выданы под существующим ключом (браузер шифрует сообщение под тот
// applicationServerKey, с которым подписался), и новый ключ их бы обнулил.

// Ключи лежат в backend/db/vapid.json. DOCS_DIR - это backend/docs, поэтому
// поднимаемся на уровень выше.
const VAPID_FILE = path.resolve(DOCS_DIR, '..', 'db', 'vapid.json');

interface Vapid {
  /** applicationServerKey: base64url несжатой точки (65 байт). */
  publicKey: string;
  /** Приватный ключ в виде base64url-скаляра (32 байта) - формат web-push. */
  privateKey: string;
  subject: string;
}

// undefined - ещё не читали, null - ключей нет (push отключён).
let cached: Vapid | null | undefined;

/**
 * PKCS8-PEM -> пара base64url-строк, которые ждёт web-push. Библиотека
 * принимает только "сырые" ключи, поэтому PEM разбираем через node:crypto и
 * берём из JWK скаляр d и точку x/y.
 */
function fromPem(pem: string): { publicKey: string; privateKey: string } | null {
  try {
    const jwk = crypto.createPrivateKey(pem).export({ format: 'jwk' }) as {
      d?: string;
      x?: string;
      y?: string;
    };
    if (!jwk.d || !jwk.x || !jwk.y) return null;
    const point = Buffer.concat([
      Buffer.from([4]), // 0x04 - несжатая форма точки
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]);
    return { publicKey: point.toString('base64url'), privateKey: jwk.d };
  } catch {
    return null;
  }
}

/** Ключи: сначала переменные окружения, затем файл vapid.json. */
function load(): Vapid | null {
  if (cached !== undefined) return cached;

  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';
  const envPublic = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPrivate = (process.env.VAPID_PRIVATE_KEY || '').trim();

  if (envPublic && envPrivate) {
    // Приватный ключ в .env бывает и в PEM - принимаем оба формата.
    const converted = envPrivate.includes('BEGIN') ? fromPem(envPrivate) : null;
    cached = { publicKey: envPublic, privateKey: converted?.privateKey ?? envPrivate, subject };
    return cached;
  }

  try {
    const data = JSON.parse(readFileSync(VAPID_FILE, 'utf8')) as {
      private_pem?: string;
      public_b64?: string;
    };
    const converted = fromPem(String(data.private_pem || ''));
    if (!converted) throw new Error('в vapid.json нет пригодного private_pem');
    cached = {
      publicKey: String(data.public_b64 || converted.publicKey),
      privateKey: converted.privateKey,
      subject,
    };
  } catch (e) {
    // Файла нет или он испорчен - push просто недоступен: клиент увидит
    // available=false и не станет подписываться.
    console.warn(`[PUSH] VAPID init не удался (${VAPID_FILE}): ${String(e)}`);
    cached = null;
  }
  return cached;
}

// Тип минимально описывает то, что реально вызывается: web-push - CommonJS,
// и форма namespace-объекта различается между сборками (default vs корень).
interface WebPushLike {
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload?: string | null,
    options?: {
      vapidDetails?: { subject: string; publicKey: string; privateKey: string };
      timeout?: number;
      TTL?: number;
    }
  ): Promise<unknown>;
}

let webpushModule: Promise<WebPushLike | null> | undefined;

/**
 * Ленивая загрузка web-push. Пакет опциональный: если его нет в node_modules,
 * всё тихо деградирует до тоста в открытой вкладке, а не роняет маршрут.
 */
function loadWebpush(): Promise<WebPushLike | null> {
  if (!webpushModule) {
    webpushModule = import('web-push')
      .then((m) => ((m as unknown as { default?: WebPushLike }).default ?? m) as WebPushLike)
      .catch((e) => {
        console.warn(`[PUSH] пакет web-push недоступен: ${String(e)}`);
        return null;
      });
  }
  return webpushModule;
}

/** applicationServerKey для клиента (base64url) либо null. */
export function publicKey(): string | null {
  return load()?.publicKey || null;
}

/** Ключ есть И библиотека отправки доступна. */
export async function isAvailable(): Promise<boolean> {
  if (!publicKey()) return false;
  return (await loadWebpush()) !== null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  /** tag схлопывает повторные уведомления одного диалога. */
  tag?: string;
}

/** Собственно отправка по всем подпискам пользователя. */
async function send(userId: string, payload: PushPayload): Promise<void> {
  const vapid = load();
  if (!vapid?.privateKey) return;
  const webpush = await loadWebpush();
  if (!webpush) return;

  const subs = await prisma.push_subscriptions.findMany({ where: { user_id: userId } });
  if (!subs.length) return;

  const body = JSON.stringify(payload);
  const dead: string[] = [];

  // Отправляем параллельно: все вызовы сетевые, а у пользователя обычно 1-3
  // подписки.
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          {
            vapidDetails: {
              subject: vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey,
            },
            timeout: 10_000, // тайм-аут в миллисекундах
          }
        );
      } catch (e) {
        const status = (e as { statusCode?: number } | null)?.statusCode;
        if (status === 404 || status === 410) {
          // Подписка мертва (вкладку удалили / браузер переустановили) - иначе
          // такие endpoint'ы копятся и каждая отправка тратит на них таймаут.
          dead.push(sub.id);
        } else {
          console.warn(`[PUSH] отправка ${status ?? '—'}: ${String(e)}`);
        }
      }
    })
  );

  if (dead.length) {
    await prisma.push_subscriptions.deleteMany({ where: { id: { in: dead } } });
  }
}

/**
 * Шлёт push всем подпискам пользователя, не блокируя вызывающего: after()
 * продлевает жизнь запроса до завершения задачи. Вне контекста запроса
 * (крон-джобы планировщика) after() бросает исключение - тогда работаем
 * обычным "висящим" промисом: процесс воркера всё равно живёт дальше.
 */
export function notifyUser(userId: string | null | undefined, payload: PushPayload): void {
  if (!userId) return;
  const task = () =>
    send(userId, payload).catch((e) => {
      console.warn(`[PUSH] пользователь ${userId}: ${String(e)}`);
    });
  try {
    after(task);
  } catch {
    void task();
  }
}

/** Тот же push нескольким получателям (системные уведомления планировщика). */
export function notifyUsers(userIds: Iterable<string>, payload: PushPayload): void {
  for (const id of new Set(userIds)) notifyUser(id, payload);
}
