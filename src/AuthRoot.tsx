import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Aperture, ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole, Sparkles, UserRound } from 'lucide-react';
import type { AccountView } from '../shared/accounts';
import { accountJson } from './accountApi';
import App from './App';
import Admin from './Admin';

function Login({ onLogin, message }: { onLogin: (user: AccountView) => void; message: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await accountJson<{ account: AccountView }>('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      setPassword(''); onLogin(result.account);
    } catch (error) { setError(error instanceof Error ? error.message : '登录失败。'); }
    finally { setBusy(false); }
  }
  return <main className="login-page">
    <div className="login-brand"><Aperture size={27} /><strong>NovelAI</strong><span>IMAGE STUDIO</span></div>
    <div className="login-layout">
      <section className="login-art" aria-label="NovelAI 创作工作台">
        <span className="login-eyebrow"><Sparkles size={14} /> 灵感，从这里开始</span>
        <div className="login-orbit" aria-hidden="true"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-ring ring-three" /><div className="orbit-center"><Aperture size={70} strokeWidth={1} /></div><span className="orbit-star star-one">✦</span><span className="orbit-star star-two">✦</span><div className="orbit-label label-one"><Sparkles size={13} /> 将想象变成画面</div><div className="orbit-label label-two">无限灵感 · 每次创作</div></div>
        <h1>让想象，<br />拥有自己的画面。</h1><p>从一句提示词到一个完整世界，<br />在 NovelAI 开启你的下一次创作。</p>
        <div className="login-features"><span>文生图</span><i /><span>角色创作</span><i /><span>局部重绘</span></div>
      </section>
      <section className="login-card">
        <div className="login-card-icon"><Aperture size={26} /></div><span className="login-eyebrow">WELCOME BACK</span>
        <h2>登录 NovelAI</h2><p className="login-description">欢迎回来，继续你的创作旅程。</p>
        <form onSubmit={event => void submit(event)}>
          <label htmlFor="login-username">账号</label><div className="login-input"><UserRound size={18} /><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="输入你的账号" value={username} onChange={event => setUsername(event.target.value)} required maxLength={80} disabled={busy} /></div>
          <label htmlFor="login-password">密码</label><div className="login-input"><LockKeyhole size={18} /><input id="login-password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" placeholder="输入你的密码" value={password} onChange={event => setPassword(event.target.value)} required maxLength={200} disabled={busy} /><button type="button" className="tool" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          {(error || message) && <p className="login-error" role="alert">{error || message}</p>}
          <button type="submit" className="primary login-submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : null}<span>{busy ? '正在登录…' : '进入创作工作台'}</span>{!busy && <ArrowRight size={18} />}</button>
        </form>
        <div className="login-help">账号由管理员提供 · 如需帮助，请联系管理员</div>
      </section>
    </div>
    <footer className="login-footer"><span>NovelAI · 为每一份想象而创作</span><span>YOUR IMAGINATION, REIMAGINED.</span></footer>
  </main>;
}

export default function AuthRoot() {
  const [user, setUser] = useState<AccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [message, setMessage] = useState('');
  const authenticated = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const result = await accountJson<{ account: AccountView }>('/api/auth/me');
      authenticated.current = true; setUser(result.account); setMessage('');
    } catch (error) {
      if (error instanceof Error && !error.message.includes('请先登录')) setMessage(error.message);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    try { document.documentElement.dataset.theme = localStorage.getItem('novelai-theme') ?? 'white-pink'; } catch { /* Use the light default. */ }
    const expired = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; code: string }>).detail;
      if (authenticated.current || detail.code === 'ACCOUNT_BANNED') setMessage(detail.message);
      authenticated.current = false; setUser(null); setAdmin(false);
    };
    window.addEventListener('novelai-auth-expired', expired);
    void refresh();
    return () => window.removeEventListener('novelai-auth-expired', expired);
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => void refresh(), 30_000);
    const focused = () => void refresh();
    window.addEventListener('focus', focused);
    return () => { clearInterval(interval); window.removeEventListener('focus', focused); };
  }, [user?.username, refresh]);
  async function logout() {
    try { await accountJson('/api/auth/logout', { method: 'POST' }); authenticated.current = false; setUser(null); setAdmin(false); setMessage(''); }
    catch (error) { window.alert(error instanceof Error ? error.message : '退出失败。'); }
  }
  if (loading) return <main className="auth-loading"><Aperture size={36} /><span>NovelAI</span><LoaderCircle className="spin" size={20} /></main>;
  if (!user) return <Login message={message} onLogin={account => { authenticated.current = true; setUser(account); setMessage(''); }} />;
  if (admin && user.role === 'admin') return <Admin user={user} onBack={() => { setAdmin(false); void refresh(); }} onLogout={() => void logout()} />;
  return <App key={user.username} user={user} onAdmin={() => setAdmin(true)} onLogout={() => void logout()} />;
}
