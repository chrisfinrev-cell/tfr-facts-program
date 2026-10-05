import { api, apiRoutes } from './api';
import { clearAccessToken } from './auth-storage';
import type { AuthMeResponse, FactsUser } from './types';

export function ndaIsAccepted(user?: FactsUser | null): boolean {
  if (!user) return false;
  if (user.nda_required === false) return true;
  return Boolean(user.nda_accepted || user.nda_accepted_at);
}

export async function fetchCurrentUser(): Promise<FactsUser | null> {
  const { data } = await api.get<AuthMeResponse>(apiRoutes.me);
  if (!data.authenticated || !data.user) return null;
  return data.user;
}

export async function login(email: string, password: string): Promise<FactsUser | null> {
  await api.post(apiRoutes.login, { email, password });
  return fetchCurrentUser();
}

export async function registerBeta(input: {
  email: string;
  password: string;
  inviteCode: string;
  name?: string;
  fullName?: string;
  relationshipTag?: 'STANDARD' | 'FAMILY' | 'CLOSE_CONTACT';
  ndaAccepted?: boolean;
}): Promise<{
  requiresNda: boolean;
  referralCode?: string;
  relationshipTag?: string;
  showPersonalContactDisclosure?: boolean;
  disclosure?: string | null;
}> {
  const { data } = await api.post(apiRoutes.register, input);
  return {
    requiresNda: Boolean(data.requiresNda ?? true),
    referralCode: data.referralCode,
    relationshipTag: data.relationshipTag,
    showPersonalContactDisclosure: Boolean(data.showPersonalContactDisclosure),
    disclosure: data.disclosure || null
  };
}

export async function acceptNda(input?: { typedSignature?: string }): Promise<string> {
  const payload = { typedSignature: input?.typedSignature || '', ndaSignature: input?.typedSignature || '' };
  try {
    const { data } = await api.post(apiRoutes.ndaAccept, payload);
    return data.redirectUrl || '/dashboard';
  } catch {
    const { data } = await api.post(apiRoutes.ndaAcceptV1, payload);
    return data.redirectUrl || '/dashboard';
  }
}

export async function logout(): Promise<void> {
  try {
    await api.post(apiRoutes.logout);
  } finally {
    clearAccessToken();
  }
}
