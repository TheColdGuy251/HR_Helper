'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';

// Текущий пользователь приходит из FastAPI: GET /api/auth/me
// (см. HR Helper/routes/auth.py, api_router).
export interface AuthUser {
  id: number;
  username: string;
  email: string;
  surname: string;
  name: string;
  patronymic: string | null;
  full_name: string;
  short_name: string;
  initials: string;
  position: string;
  sex: string;
  is_admin: boolean;
  is_kb_editor: boolean;
  can_access_pii: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<{ user: AuthUser | null }>('/api/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiPost('/api/auth/logout');
    } finally {
      window.location.href = '/login';
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
