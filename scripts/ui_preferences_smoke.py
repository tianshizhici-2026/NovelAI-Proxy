"""Check theme, negative presets, slightly larger mobile text and one-click mask clearing."""
import io
import json
from pathlib import Path

from PIL import Image, PngImagePlugin
from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=20000)
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)
PRESET = 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::'
image = Image.new('RGB', (1024, 1024), '#edcedd')
buffer = io.BytesIO()
image.save(buffer, format='PNG')
blank = buffer.getvalue()
metadata = PngImagePlugin.PngInfo()
metadata.add_text('Comment', json.dumps({'prompt': 'house', 'uc': PRESET + ', glasses', 'width': 1024, 'height': 1024}))
buffer = io.BytesIO()
image.save(buffer, format='PNG', pnginfo=metadata)
imported = buffer.getvalue()


def font(locator):
    return locator.evaluate('(element) => parseFloat(getComputedStyle(element).fontSize)')


def fits(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'page overflow'
    for panel in page.locator('.mobile-drawer, .mask-toolbar, .stage-header, .topbar').all():
        if panel.is_visible():
            assert panel.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), 'panel overflow'
    covered = page.evaluate('''() => {
        const drawer = document.querySelector('.mobile-drawer');
        const scope = drawer ? '.mobile-drawer' : '.mask-editor, .mobile-nav';
        const elements = [...document.querySelectorAll('.topbar button')];
        for (const root of document.querySelectorAll(scope)) elements.push(...root.querySelectorAll('button, textarea, select, input'));
        return elements.filter(e => {
            const rect = e.getBoundingClientRect(), style = getComputedStyle(e);
            if (e.disabled || rect.width === 0 || rect.height === 0 || Number(style.opacity) === 0) return false;
            const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
            for (let p = e.parentElement; p; p = p.parentElement) {
                const s = getComputedStyle(p), r = p.getBoundingClientRect();
                if (/(auto|scroll|hidden|clip)/.test(s.overflowY) && (y < r.top || y >= r.bottom)) return false;
                if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && (x < r.left || x >= r.right)) return false;
            }
            return !e.contains(document.elementFromPoint(x, y));
        }).map(e => e.getAttribute('aria-label') || e.textContent || e.id);
    }''')
    if covered:
        page.screenshot(path=str(ARTIFACTS / 'preferences-controls-failure.png'), full_page=True)
    assert covered == [], f'covered controls: {covered}'


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1600, 'height': 1000}, has_touch=True)
    page = context.new_page()
    page.route('**/api/auth/me', lambda route: route.fulfill(json={'account': {'username': 'test-admin', 'role': 'admin', 'quota': 0, 'used': 0, 'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}}))
    errors, requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/status', lambda route: route.fulfill(json={'configured': True, 'ready': True, 'usagePercent': 86, 'message': '测试服务'}))

    def generated(route):
        requests.append(route.request.post_data_json)
        route.fulfill(body=blank, content_type='image/png')

    page.route('**/api/generate', generated)
    page.goto('http://localhost:6006', wait_until='domcontentloaded')
    expect(page.get_by_label('默认负面提示词', exact=True)).to_be_checked()
    page.get_by_label('场景提示词', exact=True).fill('house')
    page.get_by_label('负面提示词', exact=True).fill('blurry')
    desktop_font = font(page.locator('label[for="base-prompt"]'))
    for text in ['完整模型 · 多角色创作', '历史保存在当前浏览器', '0 Anlas 模式', '0 Anlas']:
        assert page.get_by_text(text, exact=True).count() == 0
    page.get_by_label('切换黑粉主题', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'black-pink')
    assert page.locator('.prompt-editor').first.evaluate('(e) => getComputedStyle(e).backgroundColor') == 'rgb(33, 27, 37)'
    page.screenshot(path=str(ARTIFACTS / 'black-pink-desktop.png'), full_page=True)
    page.locator('.default-negative-row').click()
    expect(page.get_by_label('默认负面提示词', exact=True)).not_to_be_checked()
    page.get_by_role('button', name='生成图像', exact=True).click()
    expect(page.locator('.history-item')).to_have_count(1)
    assert requests[-1]['negativePrompt'] == 'blurry' and requests[-1]['defaultNegative'] is False
    page.reload(wait_until='domcontentloaded')
    expect(page.locator('html')).to_have_attribute('data-theme', 'black-pink')
    expect(page.get_by_label('默认负面提示词', exact=True)).not_to_be_checked()
    expect(page.get_by_label('负面提示词', exact=True)).to_have_value('blurry')
    page.get_by_label('切换白粉主题', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'white-pink')
    page.get_by_label('上传图片导入元数据', exact=True).set_input_files({'name': 'preset.png', 'mimeType': 'image/png', 'buffer': imported})
    expect(page.get_by_label('负面提示词', exact=True)).to_have_value('glasses')
    expect(page.get_by_label('默认负面提示词', exact=True)).to_be_checked()
    page.get_by_role('button', name='生成图像', exact=True).click()
    expect(page.locator('.history-item')).to_have_count(2)
    assert requests[-1]['negativePrompt'] == 'glasses' and requests[-1]['defaultNegative'] is True

    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='提示词', exact=True).click()
    expect(page.locator('label[for="base-prompt"]')).to_be_visible()
    assert abs(font(page.locator('label[for="base-prompt"]')) - desktop_font * 1.15) < 0.02
    assert abs(font(page.get_by_label('负面提示词', exact=True)) - 12.65) < 0.02
    fits(page)
    page.get_by_label('切换黑粉主题', exact=True).click()
    page.screenshot(path=str(ARTIFACTS / 'black-pink-mobile-prompts.png'), full_page=True)
    page.get_by_label('关闭提示词面板', exact=True).click()
    page.get_by_role('button', name='设置', exact=True).click()
    expect(page.locator('.resolution-card')).to_have_count(3)
    fits(page)
    page.screenshot(path=str(ARTIFACTS / 'black-pink-mobile-settings.png'), full_page=True)
    page.get_by_label('关闭设置面板', exact=True).click()
    page.get_by_role('button', name='局部重绘', exact=True).click()
    page.get_by_label('上传重绘底图', exact=True).set_input_files({'name': 'base.png', 'mimeType': 'image/png', 'buffer': blank})
    expect(page.get_by_label('重绘蒙版画布')).to_be_visible()
    expect(page.get_by_label('清空蒙版', exact=True)).to_have_count(1)
    expect(page.get_by_label('清空蒙版', exact=True)).to_have_text('')
    expect(page.get_by_label('清空蒙版', exact=True).locator('svg')).to_have_count(1)
    toolbar = page.get_by_role('toolbar', name='蒙版工具').bounding_box()
    heading = page.locator('.mask-heading').bounding_box()
    previous_right = heading['x'] + heading['width']
    for button in page.get_by_role('toolbar', name='蒙版工具').get_by_role('button').all():
        rect = button.bounding_box()
        assert rect['x'] >= previous_right - 1
        assert abs(rect['y'] + rect['height'] / 2 - (heading['y'] + heading['height'] / 2)) < 2
        previous_right = rect['x'] + rect['width']
    brush = page.locator('.brush-control').bounding_box()
    assert brush['y'] - (toolbar['y'] + toolbar['height']) >= 9
    assert page.locator('.mask-controls').bounding_box()['height'] <= 64
    assert page.get_by_label('重绘画布视口').bounding_box()['height'] > 844 * 0.45
    assert page.locator('.lucide-hand').count() == 0
    canvas = page.get_by_label('重绘蒙版画布').bounding_box()
    page.mouse.move(canvas['x'] + canvas['width'] / 2, canvas['y'] + canvas['height'] / 2)
    page.mouse.down()
    page.mouse.move(canvas['x'] + canvas['width'] / 2 + 20, canvas['y'] + canvas['height'] / 2, steps=4)
    page.mouse.up()
    expect(page.locator('.mobile-generate')).to_be_enabled()
    page.get_by_label('清空蒙版', exact=True).click()
    expect(page.locator('.mobile-generate')).to_be_disabled()
    assert page.get_by_label('重绘蒙版画布').evaluate('(c) => c.getContext("2d").getImageData(0,0,c.width,c.height).data.every((v,i) => i%4!==3 || v===0)')
    page.get_by_label('撤销', exact=True).click()
    expect(page.locator('.mobile-generate')).to_be_enabled()
    fits(page)
    page.screenshot(path=str(ARTIFACTS / 'black-pink-mobile-mask.png'), full_page=True)
    page.get_by_label('切换白粉主题', exact=True).click()
    page.screenshot(path=str(ARTIFACTS / 'white-pink-mobile-mask.png'), full_page=True)
    for width, height in [(320, 568), (390, 844), (768, 1024), (1024, 768)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(150)
        fits(page)
        if width <= 980:
            assert page.locator('.mask-controls').bounding_box()['height'] <= 64
            assert page.get_by_label('重绘画布视口').bounding_box()['height'] > height * 0.45
            for panel, close in [('提示词', '关闭提示词面板'), ('设置', '关闭设置面板'), ('历史', '关闭历史面板')]:
                page.get_by_role('button', name=panel, exact=True).click()
                fits(page)
                page.get_by_label(close, exact=True).click()
    assert errors == [], errors
    print(json.dumps({'themes_persist': True, 'negative_preset_import': True, 'mobile_font_scale': 1.15, 'clear_mask_undo': True, 'mock_generations': len(requests), 'browser_errors': errors}))
    browser.close()
