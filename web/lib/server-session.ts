/**
 * Resolve the logged-in Express session user for Next.js route handlers.
 * Forwards the browser Cookie (and optional Bearer token) to /api/auth/me.
 */

export type SessionUser = {
  id: string;
  email?: string;
  is_admin?: boolean;
  is_creator?: boolean;
};

export async function getExpressSessionUser(req: Request): Promise<SessionUser | null> {
  const cookie = req.headers.get('cookie') || '';
  const authorization = req.headers.get('authorization') || '';
  if (!cookie && !authorization) return null;

  const expressOrigin = process.env.API_PROXY_URL || 'http://localhost:3000';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (authorization) headers.Authorization = authorization;

  try {
    const res = await fetch(`${expressOrigin}/api/auth/me`, {
      method: 'GET',
      headers,
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      authenticated?: boolean;
      user?: { id?: number | string; email?: string; is_admin?: boolean; is_creator?: boolean };
    };
    if (!data.authenticated || !data.user?.id) return null;
    return {
      id: String(data.user.id),
      email: data.user.email,
      is_admin: Boolean(data.user.is_admin),
      is_creator: Boolean(data.user.is_creator)
    };
  } catch (err) {
    console.error('[server-session] Failed to resolve Express session:', err);
    return null;
  }
}
