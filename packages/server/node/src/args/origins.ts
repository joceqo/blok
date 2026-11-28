export function splitOrigins(value: string): string[] {
  const origins: string[] = [];
  for (const part of value.split(',')) {
    const origin = part.trim();
    if (origin !== '') {
      origins.push(origin);
    }
  }
  return origins;
}