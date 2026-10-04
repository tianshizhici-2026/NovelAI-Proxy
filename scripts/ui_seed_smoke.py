"""Verify seed controls, imported seeds, history reuse and all request modes without upstream generation."""
import io
from PIL import Image, PngImagePlugin
from playwright.sync_api import sync_playwright, expect
import json

expect.set_options(timeout=15000)
def png(seed):
    buffer = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    info.add_itxt('Comment', json.dumps({'prompt': 'seed test', 'seed': seed, 'width': 1024, 'height': 1024}))
    Image.new('RGB', (1024, 1024), '#abcdee').save(buffer, format='PNG', pnginfo=info)
    return buffer.getvalue()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    account = {'username': 'seed-test', 'role': 'admin', 'quota': 0, 'used': 0, 'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}
    page.route('**/api/auth/me', lambda r: r.fulfill(json={'account': account}))
    page.route('**/api/status', lambda r: r.fulfill(json={'configured': True, 'ready': True, 'usagePercent': 90, 'account': account}))
    page.route('**/api/queue/*', lambda r: r.fulfill(json={'state': 'running', 'position': 0, 'generating': True, 'waiting': 0, 'capacity': 5}))
    requests, errors = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def generate(route):
        body = route.request.post_data_json
        requests.append(body)
        route.fulfill(body=png(body['seed'] if body['seed'] is not None else 987654), content_type='image/png')
    page.route('**/api/generate', generate)
    page.goto('http://127.0.0.1:6006')
    expect(page.get_by_label('Seed', exact=True)).to_have_value('random')
    expect(page.get_by_label('固定 Seed', exact=True)).to_be_disabled()
    page.get_by_label('场景提示词', exact=True).fill('seed test')
    page.get_by_label('Seed', exact=True).select_option('fixed')
    page.get_by_label('固定 Seed', exact=True).fill('0')
    for _ in range(2):
        page.get_by_role('button', name='生成图像', exact=True).click()
        expect(page.get_by_role('button', name='生成图像', exact=True)).to_be_enabled()
        assert requests[-1]['seed'] == 0
    page.get_by_label('Seed', exact=True).select_option('random')
    page.get_by_role('button', name='生成图像', exact=True).click()
    expect(page.get_by_role('button', name='复制提示词', exact=True)).to_be_enabled()
    assert requests[-1]['seed'] is None
    expect(page.get_by_label('Seed', exact=True)).to_have_value('random')
    page.get_by_role('button', name='复制提示词', exact=True).click()
    expect(page.get_by_label('固定 Seed', exact=True)).to_have_value('987654')
    file = {'name': 'seed.png', 'mimeType': 'image/png', 'buffer': png(4294967295)}
    page.get_by_label('上传图片导入元数据', exact=True).set_input_files(file)
    expect(page.get_by_label('Seed', exact=True)).to_have_value('fixed')
    expect(page.get_by_label('固定 Seed', exact=True)).to_have_value('4294967295')
    page.get_by_label('上传 图生图 参考图', exact=True).set_input_files(file)
    expect(page.get_by_alt_text('图生图 参考图', exact=True)).to_be_visible()
    page.get_by_role('button', name='生成 图生图', exact=True).click()
    expect(page.get_by_role('button', name='继续重绘', exact=True)).to_be_enabled()
    assert requests[-1]['mode'] == 'img2img' and requests[-1]['seed'] == 4294967295
    page.get_by_role('button', name='继续重绘', exact=True).click()
    expect(page.get_by_label('重绘蒙版画布', exact=True)).to_be_visible()
    box = page.get_by_label('重绘画布视口', exact=True).bounding_box()
    x, y = box['x'] + box['width']/2, box['y'] + box['height']/2
    page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x+20,y+20,steps=5); page.mouse.up()
    page.get_by_role('button', name='生成局部重绘', exact=True).click()
    expect(page.get_by_role('button', name='继续重绘', exact=True)).to_be_enabled()
    assert requests[-1]['mode'] == 'inpaint' and requests[-1]['seed'] == 4294967295
    page.reload()
    expect(page.get_by_label('固定 Seed', exact=True)).to_have_value('4294967295')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='设置', exact=True).click()
    expect(page.get_by_label('Seed', exact=True)).to_have_value('fixed')
    page.get_by_label('Seed', exact=True).select_option('random')
    expect(page.get_by_label('固定 Seed', exact=True)).to_be_disabled()
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
    assert not errors, errors
    browser.close()
    print('Seed UI passed: random/fixed, seed 0, metadata import, history reuse, all modes, persistence and mobile controls.')
