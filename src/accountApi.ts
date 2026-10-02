export async function accountFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, { ...init, credentials: 'same-origin' });
  if (response.status === 401 || response.status === 403) {
    const body = await response.clone().json().catch(() => null);
    if (body?.code === 'AUTH_REQUIRED' || body?.code === 'ACCOUNT_BANNED')
      window.dispatchEvent(new CustomEvent('novelai-auth-expired', { detail: { message: body.error, code: body.code } }));
  }
  return response;
}
export async function accountJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await accountFetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '请求失败，请稍后再试。');
  return body as T;
}
