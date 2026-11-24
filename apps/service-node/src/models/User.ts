export interface User {
  id: string;
  name: string;
  email: string;
  instanceAdmin: boolean;
}

export function parseUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const id = value.trim();
  if (/^[a-z0-9_-]+$/i.test(id)) return id;
}
