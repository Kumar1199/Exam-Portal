import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

export default function ActivateAccount() {
  const [token, setToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    const openLink = () => { setToken(new URLSearchParams(window.location.hash.slice(1)).get('token') || ''); setDone(false); setError(''); setPassword(''); setConfirm(''); };
    window.addEventListener('hashchange', openLink);
    return () => window.removeEventListener('hashchange', openLink);
  }, []);
  const validLink = /^[a-f0-9]{64}$/.test(token);
  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/proxy?path=auth/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not activate your account. Try again.');
      setDone(true); setPassword(''); setConfirm('');
      window.history.replaceState(null, '', '/activate');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <main className="min-h-screen flex items-center justify-center bg-black px-4 text-white">
    <section className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-8">
      <h1 className="text-2xl font-bold">{done ? 'Your account is ready' : 'Activate your account'}</h1>
      {done ? <><p className="mt-4 text-zinc-300">Sign in with the email address that received your invitation and the password you just set.</p><Link to="/login" className="btn btn-primary mt-6">Go to login</Link></>
        : !validLink ? <p role="alert" className="mt-4 text-amber-300">Open the activation link from your invitation email. If it has expired, ask your administrator to resend it.</p>
        : <form onSubmit={submit} className="mt-5 space-y-5">
          <p className="text-sm text-zinc-400">Choose a password between 12 and 128 characters. Your activation link expires after 24 hours.</p>
          <label className="block text-sm">New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} className="input mt-2 w-full" /></label>
          <label className="block text-sm">Confirm password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirm} onChange={event => setConfirm(event.target.value)} disabled={busy} className="input mt-2 w-full" /></label>
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <button disabled={busy} type="submit" className="btn btn-primary w-full">{busy ? 'Activating…' : 'Set password and activate'}</button>
        </form>}
    </section>
  </main>;
}
