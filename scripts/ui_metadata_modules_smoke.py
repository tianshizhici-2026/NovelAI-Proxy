"""Legacy metadata conversion with actual local templates and mocked generation; no upstream spending."""
import io, json
from pathlib import Path
from PIL import Image, PngImagePlugin
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=15000)
ROOT = Path(__file__).resolve().parents[1]
LIBRARY = json.loads((ROOT/'data/prompts.json').read_text())
LIBRARY.append({'id':'test-numeric-artist','category':'artist','name':'docy520','prompt':'artist:docy520','url':'https://danbooru.donmai.us/posts?tags=docy520'})
LEGACY = '1girl, .004::artist:"chen bin"::, .34::artist:"docy520"::, 1.776::artist:nahaki::, .76::"year 2025"::, .8::"year2026"::, .34::watercolor::, .55::masterpiece, sunset::, very detailed'
REMAINING = '1girl, .55:: sunset::, very detailed'
EXPECTED = {'artist:chen bin': .1, 'artist:docy520': .3, 'artist:nahaki': 1.8, 'year 2025': .8, 'year 2026': .8, 'watercolor': .3, 'masterpiece': .6, 'very aesthetic': 1, 'no text': 1}

def png(comment):
    output = io.BytesIO(); info = PngImagePlugin.PngInfo(); info.add_itxt('Comment', json.dumps(comment))
    Image.new('RGB', (1024,1024), '#aabbcc').save(output, format='PNG', pnginfo=info)
    return output.getvalue()

original = {'prompt': LEGACY + ', very aesthetic, masterpiece, no text', 'qualityToggle': True, 'seed': 123456, 'width':1024, 'height':1024,
    'v4_prompt_original': {'caption': {'base_caption': LEGACY, 'char_captions': [{'char_caption':'girl, blue eyes', 'centers':[{'x':0,'y':1}]}]}}}
file = {'name':'legacy.png','mimeType':'image/png','buffer':png(original)}

def draft(page): return page.evaluate("JSON.parse(localStorage.getItem('novelai-draft'))")
def check(page):
    expect(page.get_by_label('场景提示词', exact=True)).to_have_value(REMAINING)
    value = draft(page)
    assert {m['prompt']:m['weight'] for m in value['promptModules']} == EXPECTED, value
    assert all(any(t['id']==m['id'] and t['prompt']==m['prompt'] for t in LIBRARY) for m in value['promptModules'])
    assert value['characters'][0]['prompt'] == 'girl, blue eyes'
    assert not value['qualityTags']

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True,args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1000})
    account = {'username':'metadata-test','role':'admin','quota':0,'used':0,'totalUsed':0,'remaining':None,'bannedUntil':0,'banned':False}
    page.route('**/api/auth/me',lambda r:r.fulfill(json={'account':account}))
    page.route('**/api/admin/prompts',lambda r:r.fulfill(json={'prompts':LIBRARY}))
    page.route('**/api/status',lambda r:r.fulfill(json={'configured':True,'ready':True,'usagePercent':50,'account':account}))
    page.route('**/api/queue/*',lambda r:r.fulfill(json={'state':'running','position':0,'generating':True,'waiting':0,'capacity':5}))
    requests, errors = [],[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    def generate(route):
        body=route.request.post_data_json;requests.append(body)
        route.fulfill(body=png({'prompt':body['prompt'],'seed':body['seed'],'novelai_proxy_modules':body['promptModules'],'width':1024,'height':1024}),content_type='image/png')
    page.route('**/api/generate',generate)
    page.goto('http://127.0.0.1:6006')
    page.get_by_label('上传图片导入元数据',exact=True).set_input_files(file)
    check(page)
    expect(page.get_by_label('Seed 数值',exact=True)).to_have_value('123456')
    expect(page.get_by_role('button',name='解锁 Seed',exact=True)).to_be_visible()
    page.get_by_role('button',name='生成图像',exact=True).click()
    expect(page.get_by_role('button',name='继续重绘',exact=True)).to_be_enabled()
    assert {m['prompt']:m['weight'] for m in requests[-1]['promptModules']}==EXPECTED
    page.get_by_label('场景提示词',exact=True).fill('changed')
    page.get_by_role('button',name='复制提示词',exact=True).click();check(page)
    page.get_by_label('上传 图生图 参考图',exact=True).set_input_files(file)
    expect(page.get_by_alt_text('图生图 参考图',exact=True)).to_be_visible();check(page)
    expect(page.get_by_role('button',name='锁定 Seed',exact=True)).to_be_visible()
    page.get_by_role('button',name='生成 图生图',exact=True).click()
    expect(page.get_by_role('button',name='继续重绘',exact=True)).to_be_enabled()
    assert requests[-1]['mode']=='img2img' and requests[-1]['seed']!=123456
    page.get_by_role('button',name='继续重绘',exact=True).click()
    expect(page.get_by_label('重绘蒙版画布',exact=True)).to_be_visible();check(page)
    page.reload();check(page)
    page.set_viewport_size({'width':390,'height':844})
    page.get_by_role('button',name='提示词',exact=True).click()
    expect(page.get_by_label('artist:chen bin 权重',exact=True)).to_have_text('0.1')
    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
    page.screenshot(path=str(ROOT/'artifacts/novelai-legacy-modules-mobile.png'))
    # A regular user still receives all tags from new modular metadata in the main text.
    user=browser.new_page(viewport={'width':1440,'height':1000})
    regular={**account,'username':'metadata-user','role':'user','quota':50,'remaining':50}
    user.route('**/api/auth/me',lambda r:r.fulfill(json={'account':regular}))
    user.route('**/api/status',lambda r:r.fulfill(json={'configured':True,'ready':True,'usagePercent':50,'account':regular}))
    user.goto('http://127.0.0.1:6006')
    modular={'name':'modular.png','mimeType':'image/png','buffer':png({'prompt':'forest','qualityToggle':False,'novelai_proxy_modules':[{'id':'old-id','category':'artist','prompt':'artist:chen bin','weight':.21}]})}
    user.get_by_label('上传图片导入元数据',exact=True).set_input_files(modular)
    expect(user.get_by_label('场景提示词',exact=True)).to_have_value('0.2::artist:chen bin::, forest')
    assert not errors, errors
    browser.close();print('Legacy metadata extraction, rounding, generation, img2img, history, seed, persistence, mobile and ordinary-user imports passed.')
