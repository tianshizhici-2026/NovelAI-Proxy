"""Verify module searches and unclipped balances with mocked APIs, without generation."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LIBRARY = json.loads((ROOT / 'data/prompts.json').read_text()) + [
    {'id': 'test-search-' + name, 'category': 'artist', 'name': name,
     'prompt': 'artist:' + name, 'url': 'https://example.com'} for name in ['docy520', 'xxx123']
]
if not any(item['prompt'] == 'artist collaboration' for item in LIBRARY):
    LIBRARY.append({'id':'test-suppression','category':'quality','name':'抑制画师协作',
                    'prompt':'artist collaboration','defaultWeight':-5,'url':'https://example.com'})
expect.set_options(timeout=15000)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    account = {'username': 'tianshizhici', 'role': 'admin', 'quota': 0, 'used': 0,
               'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}
    page.route('**/api/auth/me', lambda r: r.fulfill(json={'account': account}))
    page.route('**/api/admin/prompts', lambda r: r.fulfill(json={'prompts': LIBRARY}))
    page.route('**/api/admin/accounts', lambda r: r.fulfill(json={'accounts': [account]}))
    page.route('**/api/status', lambda r: r.fulfill(json={'configured': True, 'ready': True,
        'usagePercent': 100, 'anlas': {'subscription': 123000, 'purchased': 456, 'total': 123456}, 'account': account}))
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:6006')
    expect(page.locator('.workspace-account small')).to_have_text('Opus 100% · Anlas 123456')
    for width in [320, 360, 390, 480, 700, 768, 980, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        metrics = page.locator('.workspace-account small').evaluate('''e => {
            const brand = document.querySelector('.topbar .brand').getBoundingClientRect();
            const controls = document.querySelector('.topbar-right').getBoundingClientRect();
            return {client: e.clientWidth, scroll: e.scrollWidth, brandRight: brand.right,
                controlsLeft: controls.left, controlsRight: controls.right, viewport: innerWidth,
                pageWidth: document.documentElement.scrollWidth};
        }''')
        assert metrics['scroll'] <= metrics['client'] + 1, (width, metrics)
        assert metrics['brandRight'] + 3 <= metrics['controlsLeft'], (width, metrics)
        assert metrics['controlsRight'] <= width and metrics['pageWidth'] <= width, (width, metrics)
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.locator('.module-library > summary').filter(has_text='添加画师串').click()
    artist = page.get_by_label('搜索画师串', exact=True)
    artist.fill('^artist:(docy520|xxx123)$')
    expect(page.locator('.prompt-module').nth(0).locator('.module-option')).to_have_count(2)
    artist.fill('/DOCY\\d+$/i')
    expect(page.locator('.prompt-module').nth(0).locator('.module-option')).to_have_count(1)
    artist.fill('[')
    expect(artist).to_have_attribute('aria-invalid', 'true')
    expect(page.get_by_role('alert')).to_contain_text('正则表达式无效')
    artist.fill('docy520')
    page.get_by_role('button', name='docy520', exact=True).click()
    expect(page.get_by_label('artist:docy520 权重', exact=True)).to_have_text('0.8')
    expect(page.locator('.prompt-module').nth(0).locator('.module-option')).to_have_count(0)
    artist.fill('')
    assert page.locator('.prompt-module').nth(0).locator('.module-option').count() > 2
    quality = page.locator('.prompt-module').nth(1)
    quality.locator(':scope > summary').click()
    quality.locator('.module-library > summary').click()
    page.get_by_label('搜索质量风格', exact=True).fill('^watercolor$')
    expect(quality.locator('.module-option')).to_have_count(1)
    page.get_by_label('搜索质量风格', exact=True).fill('^artist collaboration$')
    page.get_by_role('button', name='抑制画师协作', exact=True).click()
    expect(page.get_by_label('artist collaboration 权重', exact=True)).to_have_text('-5.0')
    page.get_by_role('button', name='artist collaboration 权重减 0.1', exact=True).click()
    expect(page.get_by_label('artist collaboration 权重', exact=True)).to_have_text('-5.1')
    page.get_by_role('button', name='artist collaboration 权重加 0.1', exact=True).click()
    expect(page.get_by_label('artist collaboration 权重', exact=True)).to_have_text('-5.0')
    page.reload()
    expect(page.locator('.module-row').filter(has_text='抑制画师协作').get_by_label('artist collaboration 权重', exact=True)).to_have_text('-5.0')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='提示词', exact=True).click()
    page.locator('.module-library > summary').filter(has_text='添加画师串').click()
    page.get_by_label('搜索画师串', exact=True).fill('xxx123')
    expect(page.locator('.prompt-module').nth(0).locator('.module-option')).to_have_count(1)
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
    page.screenshot(path=str(ROOT / 'artifacts/novelai-module-search-mobile.png'))
    page.get_by_role('button', name='关闭提示词面板', exact=True).click()
    page.get_by_role('button', name='管理中心', exact=True).click()
    page.get_by_role('button', name='提示词模块', exact=True).click()
    manager = page.get_by_label('搜索管理提示词', exact=True)
    manager.fill('^artist:(docy520|xxx123)$')
    expect(page.locator('.module-manager-item')).to_have_count(2)
    manager.fill('[')
    expect(page.get_by_role('alert')).to_contain_text('正则表达式无效')
    manager.fill('docy520')
    page.locator('.module-manager-item').get_by_role('button').click()
    expect(page.get_by_label('提示词', exact=True)).to_have_value('artist:docy520')
    page.get_by_role('button', name='返回列表', exact=True).click()
    expect(manager).to_have_value('docy520')
    page.get_by_role('button', name='质量风格', exact=True).click()
    manager.fill('watercolor|oil painting')
    assert page.locator('.module-manager-item').count() >= 2
    assert not errors, errors
    browser.close()
    print('Full balances; module regex search, negative preset weights, adjustments, persistence, add/edit and mobile passed.')
