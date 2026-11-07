/** Engine API on the same origin by default (the engine serves this build). */
const base = (import.meta.env.VITE_ENGINE_URL as string | undefined) ?? '';

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new Error(`http_${res.status}`);
  return (await res.json()) as T;
}

export const idem = (): string => crypto.randomUUID();
