import { useEffect, useState } from 'react';
import { Aperture, ArrowLeft, Ban, Check, ChevronRight, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Users, WandSparkles, Plus, Pencil, Trash2, KeyRound } from 'lucide-react';
import type { AccountView } from '../shared/accounts';
import type { ServiceStatus } from '../shared/types';
import { accountJson } from './accountApi';

function AccountCard({ account, working, onChange }: { account: AccountView; working: boolean; onChange: (username: string, change: object) => Promise<void> }) {
  const [quota, setQuota] = useState(String(account.quota));
  const [duration, setDuration] = useState('1440');
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { setQuota(String(account.quota)); }, [account.quota]);
  const valid = /^\d+$/.test(quota) && Number(quota) <= 1_000_000;
  const usedPercent = account.quota === 0 ? (account.used ? 100 : 0) : Math.min(100, account.used / account.quota * 100);
  return <article className={`account-card ${account.banned ? 'account-is-banned' : ''}`}>
    <div className="account-card-heading"><div className="account-avatar">{account.username.slice(0, 1).toUpperCase()}</div><div><h3>{account.username}</h3><span>普通用户</span></div><span className={`account-state ${account.banned ? 'state-banned' : account.remaining === 0 ? 'state-empty' : ''}`}>{account.banned ? '已封禁' : account.remaining === 0 ? '额度已用完' : '可用'}</span></div>
    <div className="account-balance"><div><span>剩余额度</span><strong>{account.remaining}<small>张</small></strong></div><p>本轮已用 <b>{account.used}</b> / {account.quota} 张</p></div>
    <div className="account-progress" role="progressbar" aria-label={`${account.username} 已使用额度`} aria-valuenow={account.used} aria-valuemin={0} aria-valuemax={Math.max(account.used, account.quota, 1)}><span style={{ width: `${usedPercent}%` }} /></div>
    <div className="account-lifetime"><WandSparkles size={14} /> 累计成功生成 <strong>{account.totalUsed} 张</strong></div>
    <div className="account-controls"><form onSubmit={event => { event.preventDefault(); if (valid) void onChange(account.username, { quota: Number(quota) }); }}><label htmlFor={`quota-${account.username}`}>每轮额度上限</label><div className="quota-input"><input id={`quota-${account.username}`} inputMode="numeric" type="number" min="0" max="1000000" step="1" required value={quota} onChange={event => setQuota(event.target.value)} disabled={working} /><span>张</span><button className="secondary" disabled={working || !valid || Number(quota) === account.quota}>保存</button></div></form>
      <div className="account-reset">{confirmReset ? <div className="reset-confirm"><span>清零本轮用量，补满至 {account.quota} 张？</span><button className="secondary" disabled={working} onClick={async () => { await onChange(account.username, { reset: true }); setConfirmReset(false); }}>确认补满</button><button className="text-button" disabled={working} onClick={() => setConfirmReset(false)}>取消</button></div> : <button className="secondary reset-button" disabled={working} onClick={() => setConfirmReset(true)}><RefreshCw size={14} /> 补满额度</button>}<small>累计用量保留；修改上限不会清零本轮用量。</small></div>
      <div className="account-ban"><label htmlFor={`ban-${account.username}`}>账号访问</label>{account.banned ? <><p className="ban-expiry">封禁至 {new Date(account.bannedUntil).toLocaleString('zh-CN', { hour12: false })}</p><button className="secondary unban-button" disabled={working} onClick={() => void onChange(account.username, { banMinutes: 0 })}><Check size={14} /> 立即解封</button></> : <div className="ban-actions"><select id={`ban-${account.username}`} value={duration} disabled={working} onChange={event => setDuration(event.target.value)}><option value="60">封禁 1 小时</option><option value="1440">封禁 24 小时</option><option value="10080">封禁 7 天</option><option value="43200">封禁 30 天</option></select><button className="secondary ban-button" disabled={working} onClick={() => void onChange(account.username, { banMinutes: Number(duration) })}><Ban size={14} /> 临时封禁</button></div>}</div>
    </div>
  </article>;
}

type ApiKeyView = { configured: boolean; masked: string; source: string };
function AccountForm({ account, working, onSave, onCancel }: { account?: AccountView; working: boolean; onSave: (body: object) => Promise<void>; onCancel: () => void }) {
  const [username, setUsername] = useState(account?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>(account?.role ?? 'user');
  const [quota, setQuota] = useState(String(account?.quota ?? 50));
  return <form className="admin-form account-card" onSubmit={event => { event.preventDefault(); void onSave({ username, role, ...(password ? { password } : {}), ...(role === 'user' ? { quota: Number(quota) } : {}) }); }}>
    <label htmlFor="account-username">账号名</label><input id="account-username" autoComplete="off" autoCapitalize="none" required maxLength={80} value={username} onChange={e => setUsername(e.target.value)} disabled={working} />
    <label htmlFor="account-password">{account ? '新密码' : '密码'}</label><input id="account-password" type="password" autoComplete="new-password" required={!account} maxLength={200} placeholder={account ? '留空则保留当前密码' : '设置登录密码'} value={password} onChange={e => setPassword(e.target.value)} disabled={working} />
    <label htmlFor="account-role">角色</label><select id="account-role" value={role} onChange={e => setRole(e.target.value as 'admin' | 'user')} disabled={working}><option value="user">普通用户</option><option value="admin">管理员</option></select>
    {role === 'user' && <><label htmlFor="account-quota">额度上限（张）</label><input id="account-quota" type="number" min="0" max="1000000" step="1" required value={quota} onChange={e => setQuota(e.target.value)} disabled={working} /></>}
    {account && <p className="admin-form-hint">修改账号名、密码或角色后，该账号需要重新登录。改名后，原账号在浏览器中的历史不会迁移。</p>}
    <div className="admin-form-actions"><button className="secondary" type="button" disabled={working} onClick={onCancel}>取消</button><button className="primary" disabled={working}>{working ? '保存中…' : account ? '保存账号' : '创建账号'}</button></div>
  </form>;
}
function ApiKeySettings({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<ApiKeyView>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { accountJson<ApiKeyView>('/api/admin/api-key').then(setStatus).catch(error => setError(error.message)); }, []);
  return <section className="account-card admin-key-card"><KeyRound size={26} /><h2>NovelAI API Key</h2><p className="admin-form-hint">所有账号共用此 Key。保存前会验证，保存后立即生效。</p>
    <p className="key-status">{status ? status.configured ? `已配置 ${status.masked}` : '尚未配置' : '正在读取…'}</p>
    <form className="admin-form" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
      try { const result = await accountJson<ApiKeyView>('/api/admin/api-key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) }); setStatus(result); setApiKey(''); setNotice('API Key 已验证并保存。'); onSaved(); }
      catch (error) { setError(error instanceof Error ? error.message : '保存失败。'); }
      finally { setBusy(false); }
    }}><label htmlFor="novelai-api-key">{status?.configured ? '更换 API Key' : '添加 API Key'}</label><input id="novelai-api-key" type="password" autoComplete="off" spellCheck={false} required maxLength={8192} value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={busy} placeholder="粘贴 NovelAI API Key" />
      {error && <p className="login-error" role="alert">{error}</p>}{notice && <p className="admin-form-hint" role="status">{notice}</p>}
      <div className="admin-form-actions"><button className="primary" disabled={busy || !apiKey.trim()}>{busy ? '正在验证…' : '验证并保存'}</button></div>
    </form></section>;
}

export default function Admin({ user, onBack, onLogout }: { user: AccountView; onBack: () => void; onLogout: () => void }) {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [loading, setLoading] = useState(true);
  const [opusPercent, setOpusPercent] = useState<number>();
  const [working, setWorking] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState<'accounts' | 'detail' | 'edit' | 'new' | 'key'>('accounts');
  const [selected, setSelected] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const account = accounts.find(item => item.username === selected);
  function navigate(nextPage: 'accounts' | 'detail' | 'edit' | 'new' | 'key', username = selected) { setPage(nextPage); setSelected(username); setError(''); setNotice(''); setConfirmDelete(false); }
  async function load() {
    try { const result = await accountJson<{ accounts: AccountView[] }>('/api/admin/accounts'); setAccounts(result.accounts); }
    catch (error) { setError(error instanceof Error ? error.message : '账号读取失败。'); }
    finally { setLoading(false); }
  }
  async function loadStatus() {
    try { const status = await accountJson<ServiceStatus>('/api/status'); setOpusPercent(status.usagePercent); } catch { setOpusPercent(undefined); }
  }
  useEffect(() => { void load(); void loadStatus(); const interval = setInterval(() => void load(), 15_000); return () => clearInterval(interval); }, []);
  async function change(username: string, change: object) {
    setWorking(username); setNotice(''); setError('');
    try {
      const result = await accountJson<{ account: AccountView; requiresLogin?: boolean }>(`/api/admin/accounts/${encodeURIComponent(username)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
      if (result.requiresLogin) { onLogout(); return; }
      setAccounts(current => current.map(account => account.username === username ? result.account : account));
      setSelected(result.account.username); setPage('detail'); setNotice('账号设置已保存。');
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败。'); }
    finally { setWorking(''); }
  }
  async function create(body: object) {
    setWorking('new'); setError('');
    try { const result = await accountJson<{ account: AccountView }>('/api/admin/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setAccounts(current => [...current, result.account]); setSelected(result.account.username); setPage('detail'); setNotice('账号已创建。'); }
    catch (error) { setError(error instanceof Error ? error.message : '创建失败。'); }
    finally { setWorking(''); }
  }
  async function remove() {
    if (!account) return; setWorking(account.username); setError('');
    try { await accountJson(`/api/admin/accounts/${encodeURIComponent(account.username)}`, { method: 'DELETE' }); setAccounts(current => current.filter(item => item.username !== account.username)); navigate('accounts', ''); setNotice('账号已删除。'); }
    catch (error) { setError(error instanceof Error ? error.message : '删除失败。'); }
    finally { setWorking(''); }
  }
  const users = accounts.filter(account => account.role === 'user');
  const title = page === 'accounts' ? '账号管理' : page === 'key' ? 'API Key 设置' : page === 'new' ? '新增账号' : page === 'edit' ? '编辑账号' : selected;
  return <div className="admin-page"><header className="topbar"><a className="brand" href="/" onClick={event => { event.preventDefault(); onBack(); }}><Aperture size={24} /><strong>Novel<span>AI</span></strong><i /><small>管理中心</small></a><div className="topbar-right"><span className="admin-identity"><ShieldCheck size={15} />{user.username}</span><button className="secondary admin-back" onClick={onBack}><ArrowLeft size={15} /><span>返回工作台</span></button><button className="tool" aria-label="退出登录" onClick={onLogout}><LogOut size={17} /></button></div></header>
    <main className="admin-main"><nav className="admin-tabs" aria-label="管理分类"><button className={page !== 'key' ? 'active' : ''} onClick={() => navigate('accounts')} disabled={!!working}><Users size={16} />账号管理</button><button className={page === 'key' ? 'active' : ''} onClick={() => navigate('key')} disabled={!!working}><KeyRound size={16} />API Key</button></nav>
      <div className="admin-breadcrumb"><button disabled={!!working} onClick={() => navigate('accounts')}>管理中心</button><ChevronRight size={12} /><span>{title}</span></div>
      <div className="admin-heading"><h1>{title}</h1><div className="admin-heading-actions">{page === 'accounts' ? <><button className="secondary" disabled={loading || !!working} onClick={() => { void load(); void loadStatus(); }}><RefreshCw size={15} />刷新</button><button className="primary" onClick={() => navigate('new')}><Plus size={15} />新增账号</button></> : page !== 'key' && <button className="secondary" disabled={!!working} onClick={() => navigate(page === 'edit' ? 'detail' : 'accounts')}><ArrowLeft size={15} />返回</button>}</div></div>
      {(error || notice) && <div className={`admin-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
      {page === 'accounts' && <><div className="admin-stats"><div><Users size={19} /><span>账号总数<strong>{accounts.length}</strong></span></div><div><WandSparkles size={19} /><span>普通用户累计生成<strong>{users.reduce((sum, account) => sum + account.totalUsed, 0)}<small>张</small></strong></span></div><div><ShieldCheck size={19} /><span>Opus 剩余额度<strong>{opusPercent === undefined ? '—' : `${Math.floor(opusPercent)}%`}</strong></span></div></div>
        {loading ? <div className="admin-loading"><LoaderCircle className="spin" size={20} />正在读取…</div> : <div className="admin-account-list">{accounts.map(account => <button className="admin-account-row" key={account.username} onClick={() => navigate('detail', account.username)}><span className="account-avatar">{account.role === 'admin' ? <ShieldCheck size={21} /> : account.username.slice(0, 1).toUpperCase()}</span><span className="account-row-name"><strong>{account.username}</strong><small>{account.role === 'admin' ? '管理员' : '普通用户'} · 累计 {account.totalUsed} 张</small></span><span className="account-row-balance">{account.role === 'admin' ? '管理员' : account.banned ? '已封禁' : `剩余 ${account.remaining} / ${account.quota}`}</span><ChevronRight size={16} /></button>)}</div>}</>}
      {page === 'new' && <AccountForm working={!!working} onSave={create} onCancel={() => navigate('accounts')} />}
      {page === 'edit' && account && <AccountForm key={account.username} account={account} working={!!working} onSave={body => change(account.username, body)} onCancel={() => navigate('detail')} />}
      {page === 'detail' && account && <div className="admin-detail"><div className="admin-detail-actions"><button className="secondary" disabled={!!working} onClick={() => navigate('edit')}><Pencil size={15} />编辑账号</button><button className="secondary" disabled={!!working || account.username === user.username} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />删除账号</button></div>
        {confirmDelete && <div className="admin-delete-confirm" role="alert"><p>删除账号 {account.username}？该账号将无法登录，用量记录也会删除。</p><div className="admin-form-actions"><button className="secondary" disabled={!!working} onClick={() => setConfirmDelete(false)}>取消</button><button className="danger-button" disabled={!!working} onClick={() => void remove()}>确认删除账号</button></div></div>}
        {account.role === 'user' ? <AccountCard key={account.username} account={account} working={!!working} onChange={change} /> : <div className="account-card"><h3>{account.username}</h3><p className="admin-form-hint">管理员 · 累计生成 {account.totalUsed} 张</p><p className="admin-form-hint">可管理账号和 API Key，不受本地额度限制。</p></div>}
      </div>}
      {page === 'key' && <ApiKeySettings onSaved={() => void loadStatus()} />}
    </main></div>;
}
