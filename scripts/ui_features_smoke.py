"""Check metadata imports and mobile mask navigation without generating upstream images."""
import base64
import gzip
import io
import json
from pathlib import Path

from PIL import Image, PngImagePlugin
from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=15000)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)
comment = {
    'prompt': '2girls, 夜景', 'uc': 'blurry', 'steps': 27, 'scale': 6.5,
    'width': 1024, 'height': 1024,
    'v4_prompt': {'use_coords': True, 'caption': {'base_caption': '2girls, 夜景', 'char_captions': [
        {'char_caption': 'girl, silver hair', 'centers': [{'x': 0, 'y': 0.4}]},
        {'char_caption': 'girl, red hair', 'centers': [{'x': 0.8, 'y': 0.6}]},
    ]}},
    'v4_negative_prompt': {'caption': {'base_caption': 'lowres', 'char_captions': [
        {'char_caption': 'hat'}, {'char_caption': 'glasses'},
    ]}},
}


def image_bytes(image, format='PNG', **kwargs):
    buffer = io.BytesIO()
    image.save(buffer, format=format, **kwargs)
    return buffer.getvalue()


image = Image.new('RGB', (1024, 1024), '#efcedd')
blank = image_bytes(image)
generated_png = image_bytes(Image.new('RGB', (1024, 1024), '#b8d7ed'))
info = PngImagePlugin.PngInfo()
info.add_text('Software', 'NovelAI')
info.add_itxt('Comment', json.dumps(comment, ensure_ascii=False), zip=True)
normal = image_bytes(image, pnginfo=info)

hidden_image = image.convert('RGBA')
payload = gzip.compress(json.dumps({'Comment': json.dumps(comment)}).encode())
data = b'stealth_pngcomp' + (len(payload) * 8).to_bytes(4, 'big') + payload
pixels = hidden_image.load()
for bit in range(len(data) * 8):
    x, y = divmod(bit, hidden_image.height)
    r, g, b, _ = pixels[x, y]
    pixels[x, y] = (r, g, b, 254 | ((data[bit // 8] >> (7 - bit % 8)) & 1))
hidden = image_bytes(hidden_image)
exif = Image.Exif()
exif[34665] = {37510: b'ASCII\0\0\0' + json.dumps(comment).encode()}
webp = image_bytes(image, format='WEBP', lossless=True, exif=exif)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1600, 'height': 1000}, has_touch=True)
    context.add_init_script("Object.defineProperty(crypto, 'randomUUID', {value: undefined})")
    page = context.new_page()
    page.route('**/api/auth/me', lambda route: route.fulfill(json={'account': {'username': 'test-admin', 'role': 'admin', 'quota': 0, 'used': 0, 'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}}))
    page.route('**/api/admin/prompts', lambda route: route.fulfill(json={'prompts': []}))
    errors, requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/status', lambda route: route.fulfill(json={
        'configured': True, 'ready': True, 'usagePercent': 86, 'message': '测试服务',
    }))

    def generated(route):
        requests.append(route.request.post_data_json)
        route.fulfill(body=generated_png, content_type='image/png')

    page.route('**/api/generate', generated)
    page.route('**/api/queue/*', lambda route: route.fulfill(json={'state': 'running', 'position': 0, 'generating': True, 'waiting': 0, 'capacity': 5}))
    page.goto('http://localhost:6006', wait_until='domcontentloaded')
    expect(page.get_by_role('button', name='导入元数据', exact=True)).to_be_visible()
    for name, mime, data in [('metadata.png', 'image/png', normal), ('hidden.png', 'image/png', hidden), ('metadata.webp', 'image/webp', webp)]:
        print('Checking import:', name, flush=True)
        if page.get_by_label('关闭提示', exact=True).count():
            page.get_by_label('关闭提示', exact=True).click()
        page.get_by_label('场景提示词', exact=True).fill('existing draft')
        page.get_by_label('上传图片导入元数据', exact=True).set_input_files({'name': name, 'mimeType': mime, 'buffer': data})
        expect(page.get_by_role('button', name='导入元数据', exact=True)).to_be_enabled(timeout=15000)
        print('Import notice:', page.locator('.toast').all_text_contents(), flush=True)
        try:
            expect(page.get_by_label('场景提示词', exact=True)).to_have_value('2girls, 夜景', timeout=15000)
        except Exception:
            print({'notice': page.locator('.toast').all_text_contents(), 'errors': errors}, flush=True)
            page.screenshot(path=str(ARTIFACTS / 'metadata-error.png'), full_page=True)
            raise
        expect(page.get_by_label('负面提示词', exact=True)).to_have_value('lowres')
        expect(page.get_by_label('角色 1 提示词', exact=True)).to_have_value('girl, silver hair')
        expect(page.get_by_label('角色 2 提示词', exact=True)).to_have_value('girl, red hair')
        expect(page.get_by_label('Guidance 数值', exact=True)).to_have_value('6.5')
        assert page.get_by_role('dialog').count() == 0
        draft = page.evaluate("JSON.parse(localStorage.getItem('novelai-draft'))")
        assert draft['steps'] == 27 and draft['characters'][0]['x'] == 0
        assert draft['characters'][0]['negativePrompt'] == 'hat'
        assert draft['qualityTags'] is False and draft['resolution'] == 'square'
    page.get_by_label('上传图片导入元数据', exact=True).set_input_files({'name': 'blank.png', 'mimeType': 'image/png', 'buffer': blank})
    expect(page.get_by_role('alert')).to_contain_text('没有可导入')
    expect(page.get_by_label('场景提示词', exact=True)).to_have_value('2girls, 夜景')
    page.reload(wait_until='domcontentloaded')
    assert page.evaluate("JSON.parse(localStorage.getItem('novelai-draft')).characters[0].x") == 0
    page.screenshot(path=str(ARTIFACTS / 'pink-desktop.png'), full_page=True)

    page.get_by_role('button', name='局部重绘', exact=True).click()
    expect(page.get_by_label('重绘强度', exact=True)).to_have_value('0.55')
    page.get_by_label('重绘强度', exact=True).fill('1')
    expect(page.locator('.inpaint-settings')).to_contain_text('不保留该部分原有结构')
    page.get_by_label('重绘 Strength 数值', exact=True).fill('0.55')
    expect(page.get_by_label('重绘强度', exact=True)).to_have_value('0.55')
    page.get_by_label('上传重绘底图', exact=True).set_input_files({'name': 'base.png', 'mimeType': 'image/png', 'buffer': blank})
    page.set_viewport_size({'width': 390, 'height': 844})
    expect(page.get_by_label('重绘蒙版画布')).to_be_visible()
    expect(page.get_by_role('button', name='移动画布', exact=True)).to_be_visible()
    for _ in range(4):
        page.get_by_role('button', name='放大画布', exact=True).click()
    assert int(page.get_by_label('画布缩放比例').inner_text().rstrip('%')) > 200
    page.get_by_role('button', name='移动画布', exact=True).click()
    viewport = page.get_by_label('重绘画布视口').bounding_box()
    cx, cy = viewport['x'] + viewport['width'] / 2, viewport['y'] + viewport['height'] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 35, cy + 25, steps=5)
    page.mouse.up()
    assert 'translate(0px, 0px)' not in page.locator('.mask-artboard').get_attribute('style')
    page.get_by_role('button', name='画笔', exact=True).click()
    canvas = page.get_by_label('重绘蒙版画布').bounding_box()
    expected_x = (cx - canvas['x']) / canvas['width'] * 1024
    expected_y = (cy - canvas['y']) / canvas['height'] * 1024
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 20, cy, steps=5)
    page.mouse.up()
    expect(page.locator('.mobile-generate')).to_be_enabled()
    page.screenshot(path=str(ARTIFACTS / 'pink-mobile-mask.png'), full_page=True)
    page.locator('.mobile-generate').click()
    expect(page.locator('.result-image img')).to_be_visible()
    mask = Image.open(io.BytesIO(base64.b64decode(requests[-1]['mask'].split(',')[1]))).convert('L')
    assert mask.size == (1024, 1024)
    assert mask.getpixel((round(expected_x), round(expected_y))) == 255
    assert mask.getpixel((10, 10)) == 0
    assert requests[-1]['mode'] == 'inpaint'
    assert requests[-1]['strength'] == 0.55

    page.get_by_role('button', name='继续重绘', exact=True).click()
    expect(page.get_by_label('画布缩放比例')).to_have_text('100%')
    page.get_by_role('button', name='清空蒙版', exact=True).click()
    viewport = page.get_by_label('重绘画布视口').bounding_box()
    cx, cy = viewport['x'] + viewport['width'] / 2, viewport['y'] + viewport['height'] / 2
    session = context.new_cdp_session(page)

    def touch(kind, points):
        session.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [
            {'x': x, 'y': y, 'id': i + 1} for i, (x, y) in enumerate(points)
        ]})

    touch('touchStart', [(cx - 35, cy)])
    touch('touchStart', [(cx - 35, cy), (cx + 35, cy)])
    touch('touchMove', [(cx - 95, cy), (cx + 95, cy)])
    touch('touchEnd', [])
    expect(page.get_by_label('画布缩放比例')).not_to_have_text('100%')
    expect(page.locator('.mobile-generate')).to_be_disabled()
    assert page.locator('canvas[aria-label="重绘蒙版画布"]').evaluate('(c) => {const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data; return d.some((v,i)=>i%4===3 && v>127)}') is False
    page.get_by_role('button', name='适应画布', exact=True).click()
    expect(page.get_by_label('画布缩放比例')).to_have_text('100%')
    page.get_by_role('button', name='缩小画布', exact=True).click()
    expect(page.get_by_label('画布缩放比例')).to_have_text('80%')
    for width, height in [(1600, 1000), (1024, 768), (768, 1024), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(100)
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), f'overflow at {width}'
    assert errors == [], errors
    print(json.dumps({'metadata_formats': ['compressed PNG', 'stealth PNG', 'WebP EXIF'], 'zoomed_mask_coordinates': True, 'touch_pinch_without_paint': True, 'browser_errors': errors, 'mock_generations': len(requests)}, ensure_ascii=False))
    browser.close()
