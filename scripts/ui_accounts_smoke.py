"""Run against npm run preview:test; uses isolated accounts and mocked upstream."""
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('NAI_UI_URL', 'http://127.0.0.1:6007')
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)
expect.set_options(timeout=15000)


def fits(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'page overflow'
    for panel in page.locator('.topbar, .login-card, .account-card, .admin-account-row').all():
        assert panel.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), 'panel overflow'


def login(page, username, password='preview-password'):
    page.get_by_label('账号', exact=True).fill(username)
    page.get_by_label('密码', exact=True).fill(password)
    page.get_by_role('button', name='进入创作工作台').click()


def row(page, username):
    return page.locator('.admin-account-row').filter(has=page.locator('strong').filter(has_text=re.compile('^' + re.escape(username) + '$')))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    login(page, 'preview-admin', 'incorrect')
    expect(page.get_by_role('alert')).to_contain_text('账号或密码不正确')
    login(page, 'preview-admin')
    expect(page.get_by_role('button', name='账号管理', exact=True)).to_be_visible()
    page.reload()
    page.get_by_role('button', name='账号管理', exact=True).click()
    expect(page.get_by_role('heading', name='账号管理', exact=True)).to_be_visible()
    fits(page)
    page.screenshot(path=str(ARTIFACTS / 'novelai-admin-list-desktop.png'), full_page=True)
    row(page, 'preview-user').click()
    card = page.locator('.account-card')
    card.get_by_label('每轮额度上限').fill('25')
    card.get_by_role('button', name='保存', exact=True).click()
    expect(card.locator('.account-balance strong')).to_have_text('25张')
    card.get_by_role('button', name='补满额度', exact=True).click()
    card.get_by_role('button', name='确认补满', exact=True).click()
    expect(card.locator('.account-balance p')).to_contain_text('本轮已用 0 / 25 张')
    card.get_by_role('button', name='临时封禁', exact=True).click()
    expect(card.locator('.account-state')).to_have_text('已封禁')
    user_context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    user_page = user_context.new_page()
    user_page.goto(BASE)
    login(user_page, 'preview-user')
    expect(user_page.get_by_role('alert')).to_contain_text('账号已暂停使用')
    card.get_by_role('button', name='立即解封', exact=True).click()
    expect(card.locator('.account-state')).to_have_text('可用')
    login(user_page, 'preview-user')
    expect(user_page.locator('.workspace-account')).to_contain_text('剩余 25 张')
    assert user_context.request.get(BASE + '/api/admin/accounts').status == 403
    assert user_context.request.get(BASE + '/api/admin/api-key').status == 403
    user_page.get_by_role('button', name='退出登录', exact=True).click()
    page.get_by_role('button', name='返回', exact=True).click()
    page.get_by_role('button', name='新增账号', exact=True).click()
    expect(page.get_by_label('额度上限（张）', exact=True)).to_have_value('50')
    page.get_by_label('账号名', exact=True).fill('new-artist')
    page.get_by_label('密码', exact=True).fill('artist-password')
    page.get_by_role('button', name='创建账号', exact=True).click()
    expect(page.get_by_role('heading', name='new-artist', exact=True).first).to_be_visible()
    login(user_page, 'new-artist', 'artist-password')
    expect(user_page.locator('.workspace-account')).to_contain_text('new-artist')
    page.get_by_role('button', name='编辑账号', exact=True).click()
    page.get_by_label('账号名', exact=True).fill('renamed-artist')
    page.get_by_label('新密码', exact=True).fill('changed-password')
    page.get_by_label('额度上限（张）', exact=True).fill('80')
    page.get_by_role('button', name='保存账号', exact=True).click()
    expect(page.locator('.account-balance strong')).to_have_text('80张')
    user_page.reload()
    expect(user_page.get_by_role('heading', name='登录 NovelAI', exact=True)).to_be_visible()
    login(user_page, 'renamed-artist', 'changed-password')
    expect(user_page.locator('.workspace-account')).to_contain_text('renamed-artist')
    for width, height in [(320, 568), (390, 844), (768, 1024)]:
        page.set_viewport_size({'width': width, 'height': height})
        fits(page)
    page.screenshot(path=str(ARTIFACTS / 'novelai-admin-detail-mobile.png'), full_page=True)
    page.get_by_role('button', name='删除账号', exact=True).click()
    expect(page.get_by_role('button', name='确认删除账号', exact=True)).to_be_visible()
    page.get_by_role('button', name='确认删除账号', exact=True).click()
    expect(row(page, 'renamed-artist')).to_have_count(0)
    assert user_context.request.get(BASE + '/api/auth/me').status == 401
    page.get_by_role('button', name='API Key', exact=True).click()
    expect(page.locator('.key-status')).to_contain_text('已配置')
    expect(page.get_by_label('更换 API Key', exact=True)).to_have_value('')
    page.get_by_label('更换 API Key', exact=True).fill('invalid-key-value')
    page.get_by_role('button', name='验证并保存', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('无效或已过期')
    page.get_by_label('更换 API Key', exact=True).fill('preview-new-key')
    page.get_by_role('button', name='验证并保存', exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('API Key 已验证并保存')
    expect(page.get_by_label('更换 API Key', exact=True)).to_have_value('')
    assert 'preview-new-key' not in context.request.get(BASE + '/api/admin/api-key').text()
    for width, height in [(320, 568), (390, 844), (1440, 1000)]:
        page.set_viewport_size({'width': width, 'height': height})
        fits(page)
    page.screenshot(path=str(ARTIFACTS / 'novelai-admin-key-desktop.png'), full_page=True)
    page.get_by_role('button', name='账号管理', exact=True).click()
    row(page, 'preview-admin').click()
    expect(page.get_by_role('button', name='删除账号', exact=True)).to_be_disabled()
    page.get_by_role('button', name='编辑账号', exact=True).click()
    page.get_by_label('新密码', exact=True).fill('updated-admin-password')
    page.get_by_role('button', name='保存账号', exact=True).click()
    expect(page.get_by_role('heading', name='登录 NovelAI', exact=True)).to_be_visible()
    login(page, 'preview-admin', 'updated-admin-password')
    expect(page.get_by_role('button', name='账号管理', exact=True)).to_be_visible()
    assert not errors, errors
    browser.close()
    print('Admin UI passed: account CRUD/login/session revocation, quota/refill/ban, API key validation/save, desktop/mobile layout.')
