import { Redis } from 'ioredis';
import { config } from './config.js';
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on('error', () => {});
export async function status(user: string, preferred: string) {
  if (preferred === 'invisible') return 'offline';
  const count = await redis.zcount(`presence:${user}`, Date.now(), '+inf');
  return count > 0 ? preferred : 'offline';
}
