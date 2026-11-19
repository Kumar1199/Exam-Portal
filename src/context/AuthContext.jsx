import { createContext, useContext, useState, useEffect } from 'react';
const AuthContext = createContext(null);
const API = '/api/proxy?path=';
async function authRequest(action, body) {
  const token = localStorage.getItem('s360_token');
  const response = await fetch(`${API}auth/${action}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Authentication failed.');
  return data;
}
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); const [role, setRole] = useState(null); const [loading, setLoading] = useState(true); const [studentData] = useState(null);
  useEffect(() => { let mounted = true; authRequest('me').then(({ user: profile }) => { if (mounted) { setUser(profile); setRole(profile.role); } }).catch(() => { localStorage.removeItem('s360_token'); }).finally(() => mounted && setLoading(false)); return () => { mounted = false; }; }, []);
  const login = async (email, password, requestedRole) => { setLoading(true); try { const result = await authRequest('login', { email, password, requestedRole }); localStorage.setItem('s360_token', result.token); setUser(result.user); setRole(result.user.role); return { success: true, role: result.user.role }; } catch (error) { return { success: false, error: error.message }; } finally { setLoading(false); } };
  const loginWithMicrosoft = async () => ({ success: false, error: 'Microsoft sign-in must be configured on the MongoDB authentication server.' });
  const logout = async () => { localStorage.removeItem('s360_token'); setUser(null); setRole(null); };
  return <AuthContext.Provider value={{ user, role, loading, studentData, login, loginWithMicrosoft, logout }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const ctx = useContext(AuthContext); if (!ctx) throw new Error('useAuth must be used within AuthProvider'); return ctx; }
