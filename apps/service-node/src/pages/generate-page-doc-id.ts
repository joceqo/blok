import { randomUUID } from 'node:crypto';

export function generatePageDocId(): string {
  return randomUUID();
}