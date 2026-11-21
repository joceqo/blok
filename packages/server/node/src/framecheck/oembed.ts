import { escapeJsonString } from '../dotnet/json-string.ts';

const MAX_TEXT = 256;
const MAX_SIZE = 4096;
const WHOLE_SIZE = /^[1-9][0-9]{0,8}$/;

export interface OEmbed {
  title?: string;
  provider_name?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
}

export function parseOEmbed(body: Uint8Array): OEmbed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const o: OEmbed = {};
  if (typeof obj.title === 'string') {
    o.title = truncateText(obj.title);
  }
  if (typeof obj.provider_name === 'string') {
    o.provider_name = truncateText(obj.provider_name);
  }
  if (typeof obj.thumbnail_url === 'string' && obj.thumbnail_url.startsWith('https://')) {
    o.thumbnail_url = obj.thumbnail_url;
  }
  const width = readSize(obj.width);
  const height = readSize(obj.height);
  if (o.thumbnail_url !== undefined && (width > 0 || height > 0)) {
    o.width = width;
    o.height = height;
  }
  return o;
}

export function oembedEmpty(o: OEmbed): boolean {
  return (
    (o.title ?? '') === ''
    && (o.provider_name ?? '') === ''
    && (o.thumbnail_url ?? '') === ''
    && (o.width ?? 0) === 0
    && (o.height ?? 0) === 0
  );
}

export function appendOembedJson(body: string, o: OEmbed): string {
  const fields: string[] = [];
  if (o.title !== undefined) {
    fields.push(`"title":${escapeJsonString(o.title)}`);
  }
  if (o.provider_name !== undefined) {
    fields.push(`"provider_name":${escapeJsonString(o.provider_name)}`);
  }
  if (o.thumbnail_url !== undefined) {
    fields.push(`"thumbnail_url":${escapeJsonString(o.thumbnail_url)}`);
  }
  if (o.width !== undefined && o.width > 0) {
    fields.push(`"width":${o.width}`);
  }
  if (o.height !== undefined && o.height > 0) {
    fields.push(`"height":${o.height}`);
  }
  if (fields.length === 0) {
    return body;
  }
  const insert = body.lastIndexOf('}');
  return `${body.slice(0, insert)},"oembed":{${fields.join(',')}}${body.slice(insert)}`;
}

function truncateText(text: string): string {
  if ([...text].length <= MAX_TEXT) {
    return text;
  }
  return [...text].slice(0, MAX_TEXT).join('');
}

function readSize(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return 0;
  }
  const raw = String(value);
  if (!WHOLE_SIZE.test(raw)) {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  return Math.min(n, MAX_SIZE);
}