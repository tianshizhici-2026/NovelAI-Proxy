"""Reference upload, request snapshot, PNG download/re-import and responsive UI; APIs intercepted."""
from pathlib import Path
import base64
import subprocess
from PIL import Image
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=15000)
ROOT = Path(__file__).resolve().parents[1]
result = subprocess.check_output(['node', '--import', 'tsx', '--input-type=module', '-'], cwd=ROOT, input=b"""
import sharp from 'sharp';
import {DEFAULT_SETTINGS} from './shared/types.ts';
import {inputSchema,buildPayload} from './server/policy.ts';
import {attachGenerationMetadata} from './server/metadata.ts';
const png=await sharp({create:{width:1024,height:1024,channels:3,background:'#eac4d8'}}).png().toBuffer();
const input=inputSchema.parse({...DEFAULT_SETTINGS,mode:'img2img',prompt:'forest \\u6f2b\\u753b',negativePrompt:'blurry',resolution:'square',strength:.63,noise:.27,image:'fixture'});
const payload=buildPayload(input,{image:'fixture'});payload.parameters.seed=987654;
process.stdout.write(await attachGenerationMetadata(png,png,input,payload));
""")
reference = Path('/tmp/novelai-img2img-reference.png')
Image.new('RGB', (400, 400), '#80a8c0').save(reference)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.add_init_script('''if (!localStorage.getItem('novelai-draft')) localStorage.setItem('novelai-draft', JSON.stringify({prompt:'',negativePrompt:'',characters:[{id:'position-test',name:'',prompt:'',negativePrompt:'',enabled:true,x:0.5,y:0.5}],useCoords:true,strength:0.01}));''')
    page.add_init_script('''if (!localStorage.getItem('novelai-draft:inpaint-strength')) localStorage.setItem('novelai-draft:inpaint-strength', '0.01');''')
    account = {'username': 'img2img-test', 'role': 'admin', 'quota': 0, 'used': 0, 'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}
    page.route('**/api/auth/me', lambda route: route.fulfill(json={'account': account}))
    page.route('**/api/status', lambda route: route.fulfill(json={'configured': True, 'ready': True, 'usagePercent': 91, 'account': account}))
    errors, submitted = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def generate(route):
        submitted.append(route.request.post_data_json)
        route.fulfill(body=result, content_type='image/png')
    page.route('**/api/generate', generate)
    page.route('**/api/queue/*', lambda route: route.fulfill(json={'state': 'running', 'position': 0, 'generating': True, 'waiting': 0, 'capacity': 5}))
    page.goto('http://127.0.0.1:6006')
    expect(page.get_by_label('角色位置', exact=True)).to_have_value('auto')
    expect(page.get_by_role('option', name='AI 决定', exact=True)).to_have_count(1)
    page.get_by_role('button', name='图生图', exact=True).click()
    expect(page.get_by_role('button', name='生成 图生图', exact=True)).to_be_disabled()
    page.get_by_label('上传 图生图 参考图', exact=True).set_input_files(reference)
    expect(page.get_by_alt_text('图生图 参考图', exact=True)).to_be_visible()
    box = page.locator('.reference-editor button').bounding_box()
    assert box['y'] >= 0 and box['y'] + box['height'] <= 1000
    page.get_by_label('场景提示词', exact=True).fill('forest 漫画')
    page.get_by_label('负面提示词', exact=True).fill('blurry')
    page.get_by_label('图生图 Strength 数值', exact=True).fill('0.63')
    page.get_by_label('图生图 Noise 数值', exact=True).fill('0.27')
    page.screenshot(path=str(ROOT / 'artifacts/novelai-img2img-desktop.png'))
    page.get_by_role('button', name='生成 图生图', exact=True).click()
    expect(page.get_by_alt_text('当前生成结果', exact=True)).to_be_visible()
    assert len(submitted) == 1
    request = submitted[0]
    assert request['mode'] == 'img2img' and request['strength'] == 0.63 and request['noise'] == 0.27
    assert request['image'].startswith('data:image/png;base64,') and 'mask' not in request
    expect(page.get_by_role('button', name='下载图片', exact=True)).to_have_count(0)
    page.get_by_label('场景提示词', exact=True).fill('changed draft')
    page.get_by_role('button', name='复制提示词', exact=True).click()
    expect(page.get_by_label('场景提示词', exact=True)).to_have_value('forest 漫画')
    for width, height in [(320, 568), (390, 844), (768, 1024)]:
        page.set_viewport_size({'width': width, 'height': height})
        for name in ['继续重绘', '复制提示词', '用作参考图']:
            button = page.get_by_role('button', name=name, exact=True)
            expect(button).to_be_enabled()
            assert button.evaluate('(e) => { const b=e.getBoundingClientRect(); return b.top>=0 && b.bottom<=innerHeight && e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)); }'), name
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(ROOT / 'artifacts/novelai-img2img-result-actions-mobile.png'))
    page.get_by_role('button', name='继续重绘', exact=True).click()
    expect(page.get_by_label('重绘蒙版画布', exact=True)).to_be_visible()
    expect(page.get_by_label('重绘 Strength 数值', exact=True)).to_have_value('0.55')
    page.get_by_label('重绘 Strength 数值', exact=True).fill('0.72')
    box = page.get_by_label('重绘画布视口', exact=True).bounding_box()
    x, y = box['x'] + box['width']/2, box['y'] + box['height']/2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x+20, y+10, steps=5); page.mouse.up()
    expect(page.locator('.mobile-generate')).to_be_enabled()
    page.locator('.mobile-generate').click()
    expect(page.get_by_role('button', name='用作参考图', exact=True)).to_be_enabled()
    assert submitted[-1]['mode'] == 'inpaint' and submitted[-1]['mask'].startswith('data:image/png;base64,')
    assert submitted[-1]['strength'] == 0.72
    page.get_by_role('button', name='用作参考图', exact=True).click()
    expect(page.get_by_alt_text('图生图 参考图', exact=True)).to_be_visible()
    expect(page.get_by_label('图生图 Strength 数值', exact=True)).to_have_value('0.63')
    expect(page.locator('.mobile-generate')).to_be_enabled()
    page.locator('.mobile-generate').click()
    expect(page.get_by_role('button', name='继续重绘', exact=True)).to_be_enabled()
    assert submitted[-1]['mode'] == 'img2img' and 'mask' not in submitted[-1]
    page.set_viewport_size({'width': 1440, 'height': 1000})
    # Read the same original PNG backing the native image save action.
    downloaded = Path('/tmp/novelai-img2img-downloaded.png')
    encoded = page.get_by_alt_text('当前生成结果', exact=True).evaluate('async (e) => {const blob=await (await fetch(e.src)).blob();return await new Promise(resolve => {const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(",")[1]);reader.readAsDataURL(blob);});}')
    downloaded.write_bytes(base64.b64decode(encoded))
    with Image.open(downloaded) as png:
        import json
        metadata = json.loads(png.info['Comment'])
        assert metadata['seed'] == 987654 and metadata['mode'] == 'img2img'
        assert metadata['strength'] == 0.63 and metadata['noise'] == 0.27
    page.get_by_role('button', name='文生图', exact=True).click()
    page.get_by_label('场景提示词', exact=True).fill('replace this')
    page.get_by_label('上传图片导入元数据', exact=True).set_input_files(downloaded)
    expect(page.get_by_label('场景提示词', exact=True)).to_have_value('forest 漫画')
    page.get_by_role('button', name='图生图', exact=True).click()
    expect(page.get_by_label('图生图 Strength 数值', exact=True)).to_have_value('0.63')
    expect(page.get_by_label('图生图 Noise 数值', exact=True)).to_have_value('0.27')
    page.get_by_label('场景提示词', exact=True).fill('overwrite this on reference upload')
    page.get_by_label('负面提示词', exact=True).fill('replace negative')
    page.get_by_label('图生图 Strength 数值', exact=True).fill('0.12')
    page.get_by_label('图生图 Noise 数值', exact=True).fill('0.09')
    page.get_by_label('上传 图生图 参考图', exact=True).set_input_files(downloaded)
    expect(page.locator('.toast')).to_contain_text('并覆盖提示词、角色和生成参数')
    expect(page.get_by_label('场景提示词', exact=True)).to_have_value('forest 漫画')
    expect(page.get_by_label('负面提示词', exact=True)).to_have_value('blurry')
    expect(page.get_by_label('图生图 Strength 数值', exact=True)).to_have_value('0.63')
    expect(page.get_by_label('图生图 Noise 数值', exact=True)).to_have_value('0.27')
    page.get_by_label('上传 图生图 参考图', exact=True).set_input_files(reference)
    expect(page.locator('.toast')).to_contain_text('可调整 Strength 和 Noise')
    expect(page.get_by_label('场景提示词', exact=True)).to_have_value('forest 漫画')
    expect(page.get_by_label('图生图 Strength 数值', exact=True)).to_have_value('0.63')
    expect(page.get_by_label('图生图 Noise 数值', exact=True)).to_have_value('0.27')
    for width, height in [(320, 568), (390, 844), (768, 1024)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(200)
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        expect(page.get_by_role('button', name='图生图', exact=True)).to_be_visible()
        box = page.locator('.reference-editor button').bounding_box()
        nav = page.locator('.mobile-nav').bounding_box()
        assert box['y'] >= 0 and box['y'] + box['height'] <= nav['y']
        assert page.locator('.mobile-backdrop').count() == 0
        expect(page.get_by_label('图生图 Strength 数值', exact=True)).to_be_visible()
        expect(page.get_by_label('图生图 Noise 数值', exact=True)).to_be_visible()
        page.get_by_label('图生图 Noise 数值', exact=True).fill('0')
    page.screenshot(path=str(ROOT / 'artifacts/novelai-img2img-mobile.png'))
    page.get_by_label('图生图 Strength 数值', exact=True).fill('0.01')
    page.locator('.mobile-generate').click()
    expect(page.get_by_role('button', name='继续重绘', exact=True)).to_be_enabled()
    assert submitted[-1]['strength'] == 0.01 and submitted[-1]['noise'] == 0
    page.get_by_role('button', name='继续重绘', exact=True).click()
    expect(page.get_by_label('重绘 Strength 数值', exact=True)).to_have_value('0.55')
    page.get_by_role('button', name='图生图', exact=True).click()
    expect(page.get_by_label('图生图 Strength 数值', exact=True)).to_have_value('0.01')
    page.reload()
    page.get_by_role('button', name='局部重绘', exact=True).click()
    expect(page.get_by_label('重绘 Strength 数值', exact=True)).to_have_value('0.55')
    page.get_by_role('button', name='图生图', exact=True).click()
    expect(page.get_by_label('图生图 Strength 数值', exact=True)).to_have_value('0.01')
    page.get_by_role('button', name='局部重绘', exact=True).click()
    page.get_by_label('重绘 Strength 数值', exact=True).fill('0.01')
    page.get_by_role('button', name='文生图', exact=True).click()
    page.locator('.mobile-generate').click()
    expect(page.get_by_role('button', name='继续重绘', exact=True)).to_be_enabled()
    assert submitted[-1]['mode'] == 'generate'
    page.get_by_role('button', name='继续重绘', exact=True).click()
    expect(page.get_by_label('重绘 Strength 数值', exact=True)).to_have_value('0.55')
    box = page.get_by_label('重绘画布视口', exact=True).bounding_box()
    x, y = box['x'] + box['width']/2, box['y'] + box['height']/2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x+20, y+10, steps=5); page.mouse.up()
    expect(page.locator('.mobile-generate')).to_be_enabled()
    page.locator('.mobile-generate').click()
    expect(page.get_by_role('button', name='继续重绘', exact=True)).to_be_enabled()
    assert submitted[-1]['mode'] == 'inpaint' and submitted[-1]['strength'] == 0.55
    assert not errors, errors
    browser.close()
    print('图生图 UI passed: upload/preview, strength/noise request, PNG metadata download/re-import, 320/390/768 widths.')
