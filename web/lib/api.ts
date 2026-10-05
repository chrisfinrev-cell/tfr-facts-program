import axios, { type AxiosError } from 'axios';
import { clearAccessToken, getAccessToken, setAccessToken } from './auth-storage';

/**
 * Live Express routes (current FACTS backend).
 * Requested /api/v1/* names are aliased to these so the React app
 * talks to the existing Node server without a second API surface.
 */
export const apiRoutes = {
  login: '/api/auth/login',
  register: '/api/auth/register-beta',
  me: '/api/auth/me',
  logout: '/api/auth/logout',
  ndaAccept: '/api/nda/accept',
  ndaAcceptV1: '/api/v1/nda/accept',
  onboardingComplete: '/api/v1/onboarding/complete',
  buckets: '/api/engine/transactions',
  plaidCreateLinkToken: '/api/mod_plaid/create-link-token',
  plaidExchangeToken: '/api/mod_plaid/exchange-token',
  plaidCreateLinkTokenV1: '/api/v1/plaid/create-link-token',
  plaidExchangeTokenV1: '/api/v1/plaid/exchange-token'
} as const;

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || '',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => {
    const token = response.data?.token || response.data?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      setAccessToken(token);
    }
    return response;
  },
  (error: AxiosError) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      clearAccessToken();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  }
);
