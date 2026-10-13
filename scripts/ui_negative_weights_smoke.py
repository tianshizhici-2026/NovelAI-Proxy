"""Exercise collapsed negatives, preset info and negative-weight metadata against the isolated server."""
import io, json, os
from PIL import Image
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=20000)
BASE = os.environ.get('NAI_PREVIEW_URL', 'http://127.0.0.1:6008')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    generated_png=[]
    def capture_generation(route):
        upstream=route.fetch()
        generated_png.append(upstream.body())
        route.fulfill(response=upstream)
    page.route('**/api/generate',capture_generation)
    page.goto(BASE)
    page.get_by_label('账号',exact=True).fill('preview-user')
    page.get_by_label('密码',exact=True).fill('preview-password')
    page.get_by_role('button',name='进入创作工作台').click()
    expect(page.get_by_label('场景提示词',exact=True)).to_have_value('')
    assert page.locator('#base-prompt').evaluate('(e)=>!e.closest("details")')
    groups=page.locator('.global-negative')
    expect(groups).to_have_count(2)
    for group in groups.all():
        assert not group.evaluate('(e)=>e.open')
        assert group.locator('textarea').input_value()==''
    assert page.locator('.default-negative-details').count()==0
    toggle=page.get_by_label('默认负面提示词',exact=True)
    expect(toggle).to_be_checked()
    page.get_by_role('button',name='查看默认负面详情',exact=True).click()
    dialog=page.get_by_role('dialog',name='默认负面详情',exact=True)
    expect(dialog).to_contain_text('V5 Light')
    expect(dialog).to_contain_text('0::ai-generated::')
    expect(toggle).to_be_checked()
    page.keyboard.press('Escape');expect(dialog).not_to_be_visible()
    toggle.uncheck()
    page.locator('.global-negative > summary').filter(has_text='负面提示词').click()
    page.get_by_label('负面提示词',exact=True).fill('open hands')
    page.locator('.global-negative > summary').filter(has_text='负数权重').click()
    page.get_by_label('负数权重',exact=True).fill('3::hands::, .35::hat::, -2::glasses::')
    page.get_by_label('场景提示词',exact=True).fill('1girl, outdoors')
    with page.expect_response('**/api/generate') as generated:
        page.get_by_role('button',name='生成图像',exact=True).click()
    response=generated.value;assert response.status==200
    png=generated_png[-1];meta=json.loads(Image.open(io.BytesIO(png)).info['Comment'])
    assert meta['prompt'].endswith('-3::hands::, -0.35::hat::, -2::glasses::'),meta['prompt']
    assert meta['uc']=='open hands'
    assert meta['v4_prompt_original']['caption']['base_caption']=='1girl, outdoors'
    assert meta['novelai_proxy_negative_weights']=='3::hands::, .35::hat::, -2::glasses::'
    expect(page.get_by_role('button',name='复制提示词',exact=True)).to_be_enabled()
    page.get_by_label('负数权重',exact=True).fill('other')
    page.get_by_role('button',name='复制提示词',exact=True).click()
    expect(page.get_by_label('负数权重',exact=True)).to_have_value('3::hands::, .35::hat::, -2::glasses::')
    # Importing a result restores each separate field and does not duplicate its weighted suffix.
    page.get_by_label('上传图片导入元数据',exact=True).set_input_files({'name':'negative.png','mimeType':'image/png','buffer':png})
    expect(page.get_by_label('场景提示词',exact=True)).to_have_value('1girl, outdoors')
    expect(page.get_by_label('负数权重',exact=True)).to_have_value('3::hands::, .35::hat::, -2::glasses::')
    page.get_by_role('button',name='Medium',exact=True).click()
    expect(toggle).to_be_checked();expect(toggle).to_be_disabled()
    expect(page.get_by_label('负面提示词',exact=True)).to_be_disabled()
    expect(page.get_by_label('负数权重',exact=True)).to_be_enabled()
    page.get_by_role('button',name='查看默认负面详情',exact=True).click()
    expect(dialog).to_contain_text('V5 Heavy')
    expect(dialog).to_contain_text('Medium 固定启用')
    page.get_by_role('button',name='关闭默认负面详情',exact=True).click()
    with page.expect_response('**/api/generate') as generated:
        page.get_by_role('button',name='生成图像',exact=True).click()
    meta=json.loads(Image.open(io.BytesIO(generated_png[-1])).info['Comment'])
    assert meta['effort']=='medium' and '-3::hands::' in meta['prompt']
    assert meta['uc']!='open hands'
    expect(page.get_by_role('button',name='复制提示词',exact=True)).to_be_enabled()
    page.reload()
    for group in groups.all():assert not group.evaluate('(e)=>e.open')
    assert page.get_by_label('负数权重',exact=True).input_value()=='3::hands::, .35::hat::, -2::glasses::'
    page.get_by_role('button',name='High',exact=True).click()
    expect(toggle).not_to_be_checked()
    assert page.get_by_label('负面提示词',exact=True).input_value()=='open hands'
    for width,height in [(320,568),(390,844)]:
        page.set_viewport_size({'width':width,'height':height})
        page.get_by_role('button',name='提示词',exact=True).click()
        if not groups.nth(1).evaluate('(e)=>e.open'):
            page.locator('.global-negative > summary').filter(has_text='负数权重').click()
        expect(page.get_by_label('负数权重',exact=True)).to_be_visible()
        page.get_by_role('button',name='查看默认负面详情',exact=True).click()
        expect(dialog).to_be_visible()
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        page.screenshot(path=f'artifacts/novelai-negative-info-{width}.png')
        page.get_by_role('button',name='关闭默认负面详情',exact=True).click()
        page.get_by_role('button',name='关闭提示词面板',exact=True).click()
    assert not errors,errors
    browser.close()
    print('Negative weights UI passed: empty/default-folded inputs, expanded positive, independent toggle/info, signed payloads, High/Medium, metadata/history/draft, mobile.')
