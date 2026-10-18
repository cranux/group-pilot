import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/endpoints';
import { sessionStore } from '../api/instance';
import { useSession } from '../auth/useSession';
import { ErrorBox } from '../components/ErrorBox';

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/accounts';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (session.status === 'authenticated') return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = await api.login(username.trim(), password);
      sessionStore.setSession(payload);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  const expired = session.status === 'anonymous' && session.reason === 'expired';

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>GroupPilot 控制台</h1>
        <p className="muted">多账号群组消息平台 · 操作控制台</p>
        {expired ? <div className="alert alert-warning">会话已过期，请重新登录。</div> : null}
        <label className="field">
          <span>用户名</span>
          <input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <ErrorBox error={error} title="登录失败" />
        <button type="submit" className="btn btn-primary btn-block" disabled={pending || !username || !password}>
          {pending ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
