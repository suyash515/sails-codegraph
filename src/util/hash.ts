import { createHash } from 'node:crypto';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function shortHash(data: string): string {
  return createHash('sha1').update(data).digest('hex').slice(0, 16);
}
