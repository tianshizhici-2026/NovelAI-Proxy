"""Verify prompt sheet gestures with real touch input; all APIs are intercepted."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ARTIFACTS = Path(__file__).resolve().parents[1] / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)
expect.set_options(timeout=15000)


def swipe(page, cdp, x, start_y, end_y):
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': start_y}]})
    for step in range(1, 13):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': start_y + (end_y - start_y) * step / 12}]})
        page.wait_for_timeout(20)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(250)


def center(locator):
    box = locator.bounding_box()
    return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    cdp = context.new_cdp_session(page)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    account = {'username': 'sheet-user', 'role': 'user', 'quota': 50, 'used': 0, 'totalUsed': 0, 'remaining': 50, 'bannedUntil': 0, 'banned': False}
    page.route('**/api/auth/me', lambda route: route.fulfill(json={'account': account}))
    page.route('**/api/status', lambda route: route.fulfill(json={'configured': True, 'ready': True, 'usagePercent': 91, 'message': '已连接', 'account': account}))
    page.goto('http://127.0.0.1:6006')
    peek = page.get_by_role('button', name='上滑展开提示词面板', exact=True)
    expect(peek).to_be_visible()
    x, y = center(peek)
    swipe(page, cdp, x, y, y - 300)
    sheet = page.get_by_role('dialog', name='创作提示词面板', exact=True)
    expect(sheet).to_be_visible()
    original_height = sheet.bounding_box()['height']
    assert abs(original_height - 844) < 2
    assert abs(sheet.bounding_box()['y']) < 2
    page.get_by_label('场景提示词', exact=True).fill('preserved draft')
    page.screenshot(path=str(ARTIFACTS / 'prompt-sheet-open-mobile.png'))
    grip = page.get_by_role('button', name='拖动提示词面板：上滑展开，下拖收起', exact=True)
    x, y = center(grip)
    swipe(page, cdp, x, y, max(1, y - 260))
    expect(sheet).to_be_visible()
    assert abs(sheet.bounding_box()['height'] - original_height) < 2
    page.screenshot(path=str(ARTIFACTS / 'prompt-sheet-expanded-mobile.png'))
    x, y = center(grip)
    swipe(page, cdp, x, y, y + 240)
    expect(sheet).to_have_count(0)
    expect(peek).to_be_visible()
    page.screenshot(path=str(ARTIFACTS / 'prompt-sheet-collapsed-mobile.png'))
    peek.click()
    expect(sheet).to_be_visible()
    expect(page.get_by_label('场景提示词', exact=True)).to_have_value('preserved draft')
    for _ in range(3):
        page.get_by_label('添加角色', exact=True).click()
    scroll = page.locator('.prompt-sheet .prompt-scroll')
    assert scroll.evaluate('(e) => e.scrollHeight > e.clientHeight')
    scroll.evaluate('(e) => {e.scrollTop=0}')
    box = scroll.bounding_box()
    swipe(page, cdp, box['x'] + 5, box['y'] + box['height'] - 40, box['y'] + 50)
    expect(sheet).to_be_visible()
    assert scroll.evaluate('(e) => e.scrollTop') > 50, 'content swipe must scroll without closing the sheet'
    height = sheet.bounding_box()['height']
    before = scroll.evaluate('(e) => e.scrollTop')
    swipe(page, cdp, box['x'] + 5, box['y'] + 50, box['y'] + box['height'] - 40)
    assert scroll.evaluate('(e) => e.scrollTop') < before
    assert abs(sheet.bounding_box()['height'] - height) < 2
    page.get_by_label('关闭提示词面板', exact=True).click()
    expect(sheet).to_have_count(0)
    for width, viewport_height in [(320, 568), (390, 844), (768, 1024)]:
        page.set_viewport_size({'width': width, 'height': viewport_height})
        page.wait_for_timeout(250)
        peek.click()
        expect(sheet).to_be_visible()
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert abs(sheet.bounding_box()['y']) < 2
        assert abs(sheet.bounding_box()['height'] - viewport_height) < 2
        page.get_by_label('关闭提示词面板', exact=True).click()
    page.set_viewport_size({'width': 1440, 'height': 1000})
    expect(page.locator('.prompt-panel.desktop-panel')).to_be_visible()
    expect(sheet).to_have_count(0)
    assert not errors, errors
    browser.close()
    print('Prompt sheet passed: swipe directly to fullscreen/close, native content scroll, preserved input, small/tablet screens and desktop layout.')
