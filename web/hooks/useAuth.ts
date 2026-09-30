'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { acceptNda, fetchCurrentUser, login, logout, ndaIsAccepted, registerBeta } from '@/lib/auth';

export function useAuth() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const me = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: fetchCurrentUser
  });

  const loginMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => login(email, password),
    onSuccess: async (user) => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      router.replace(ndaIsAccepted(user) ? '/dashboard' : '/nda');
    }
  });

  const registerMutation = useMutation({
    mutationFn: registerBeta,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      router.replace(result.requiresNda ? '/nda' : '/dashboard');
    }
  });

  const acceptNdaMutation = useMutation({
    mutationFn: (input?: { typedSignature?: string }) => acceptNda(input),
    onSuccess: async (redirectUrl) => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      router.replace(redirectUrl || '/dashboard');
    }
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      router.replace('/login');
    }
  });

  return {
    user: me.data ?? null,
    isLoading: me.isLoading,
    isAuthenticated: Boolean(me.data),
    ndaAccepted: ndaIsAccepted(me.data),
    login: loginMutation,
    register: registerMutation,
    acceptNda: acceptNdaMutation,
    logout: logoutMutation
  };
}
