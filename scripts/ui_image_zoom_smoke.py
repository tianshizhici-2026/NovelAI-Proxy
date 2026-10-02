"""Verify image-only wheel/pinch zoom, fixed controls, panning and native image menus."""
import io
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=15000)
ROOT = Path(__file__).resolve().parents[1]
buffer = io.BytesIO()
Image.new('RGB', (1024, 1024), '#dcb0c8').save(buffer, format='PNG')
png = buffer.getvalue()


def controls(page):
    return page.evaluate('''() => [...document.querySelectorAll('.topbar, .mobile-nav, .stage-tabs button, .img2img-controls, .img2img-controls input, .result-controls button')].filter(e => e.getBoundingClientRect().width).map(e => { const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })''')


def fills_canvas(page, root):
    stage = page.locator('.stage-content').bounding_box()
    bounds = root.bounding_box()
    assert abs(bounds['x'] - stage['x']) < 1
    assert abs(bounds['y'] - stage['y']) < 1
    assert abs(bounds['width'] - stage['width']) < 1
    caption = page.locator('.reference-caption, .image-stage-content .result-meta').bounding_box()
    assert abs(bounds['height'] + caption['height'] - stage['height']) < 1
    assert page.locator('.stage-content').evaluate('(e) => getComputedStyle(e).padding') == '0px'
    assert root.locator('img').evaluate('(e) => getComputedStyle(e).boxShadow') == 'none'


def pinch(page, session, root):
    bounds = root.bounding_box()
    x, y = bounds['x'] + bounds['width']/2, bounds['y'] + bounds['height']/2
    radius = min(bounds['width'], bounds['height'])/6
    points = [{'id': 1, 'x': x-radius, 'y': y}, {'id': 2, 'x': x+radius, 'y': y}]
    session.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': points[:1]})
    session.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': points})
    for step in range(1, 9):
        distance = radius*(1+step/8)
        session.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'id': 1, 'x': x-distance, 'y': y}, {'id': 2, 'x': x+distance, 'y': y}]})
        page.wait_for_timeout(25)
    session.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(150)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, is_mobile=True, has_touch=True)
    page = context.new_page()
    session = context.new_cdp_session(page)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    account = {'username': 'zoom-test', 'role': 'admin', 'quota': 0, 'used': 0, 'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}
    page.route('**/api/auth/me', lambda route: route.fulfill(json={'account': account}))
    page.route('**/api/status', lambda route: route.fulfill(json={'configured': True, 'ready': True, 'usagePercent': 91, 'account': account}))
    page.route('**/api/generate', lambda route: route.fulfill(body=png, content_type='image/png'))
    page.route('**/api/queue/*', lambda route: route.fulfill(json={'state': 'running', 'position': 0, 'generating': True, 'waiting': 0, 'capacity': 5}))
    page.goto('http://127.0.0.1:6006')
    page.get_by_label('场景提示词', exact=True).fill('zoom verification')
    page.get_by_label('上传 图生图 参考图', exact=True).set_input_files({'name': 'reference.png', 'mimeType': 'image/png', 'buffer': png})
    picture = page.get_by_alt_text('图生图 参考图', exact=True)
    expect(picture).to_be_visible()
    root = picture.locator('..')
    fills_canvas(page, root)
    before = controls(page)
    original_width = picture.bounding_box()['width']
    root.hover(); page.mouse.wheel(0, -300)
    expect(root).not_to_have_attribute('data-scale', '1')
    assert picture.bounding_box()['width'] > original_width * 1.5
    assert controls(page) == before
    root.dblclick()
    expect(root).to_have_attribute('data-scale', '1')
    root.hover(); page.mouse.wheel(0, 300)
    expect(root).not_to_have_attribute('data-scale', '1')
    assert picture.bounding_box()['width'] < original_width * 0.75
    assert controls(page) == before
    root.dblclick(); expect(root).to_have_attribute('data-scale', '1')
    for width, height in [(320, 568), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        expect(page.locator('.mobile-nav')).to_be_visible()
        fills_canvas(page, root)
        before = controls(page)
        original_width = picture.bounding_box()['width']
        pinch(page, session, root)
        assert float(root.get_attribute('data-scale')) > 1.7
        assert picture.bounding_box()['width'] > original_width * 1.7
        assert controls(page) == before
        assert page.evaluate('visualViewport.scale') == 1
        root.dblclick(); expect(root).to_have_attribute('data-scale', '1')
    page.locator('.mobile-generate').click()
    picture = page.get_by_alt_text('当前生成结果', exact=True)
    expect(picture).to_be_visible()
    expect(page.get_by_role('button', name='继续重绘', exact=True)).to_be_enabled()
    root = picture.locator('..')
    fills_canvas(page, root)
    original_src = picture.get_attribute('src')
    before = controls(page)
    pinch(page, session, root)
    assert float(root.get_attribute('data-scale')) > 1.7
    assert controls(page) == before
    assert page.evaluate('visualViewport.scale') == 1
    assert picture.get_attribute('src') == original_src
    assert picture.evaluate('(e) => e.dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,cancelable:true}))'), 'native image menu must remain allowed'
    root_box = root.bounding_box()
    x, y = root_box['x']+root_box['width']/2, root_box['y']+root_box['height']/2
    page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x+25,y+20,steps=5); page.mouse.up()
    assert 'translate(0px, 0px)' not in picture.get_attribute('style')
    assert controls(page) == before
    page.screenshot(path=str(ROOT/'artifacts/novelai-image-only-zoom-mobile.png'))
    page.get_by_role('button', name='全屏预览', exact=True).click()
    fullscreen = page.get_by_alt_text('生成结果全屏预览', exact=True).locator('..')
    expect(fullscreen).to_be_visible()
    pinch(page, session, fullscreen)
    assert float(fullscreen.get_attribute('data-scale')) > 1.7
    assert page.evaluate('visualViewport.scale') == 1
    page.get_by_label('关闭全屏', exact=True).click()
    page.get_by_role('button', name='文生图', exact=True).click()
    fills_canvas(page, root)
    page.get_by_role('button', name='继续重绘', exact=True).click()
    expect(page.get_by_label('重绘蒙版画布', exact=True)).to_be_visible()
    assert 'image-stage-content' not in page.locator('.stage-content').get_attribute('class')
    page.get_by_role('button', name='查看结果', exact=True).click()
    expect(page.get_by_alt_text('当前生成结果', exact=True)).to_be_visible()
    fills_canvas(page, page.get_by_alt_text('当前生成结果', exact=True).locator('..'))
    page.screenshot(path=str(ROOT/'artifacts/novelai-image-fill-mobile.png'))
    assert not errors, errors
    browser.close()
    print('Image zoom passed: wheel/pinch/pan affect images only; controls/viewport stay fixed; native menu and original PNG remain available.')
