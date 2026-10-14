"""Verify native/HTTP clipboard writes and module combination file round trips without upstream requests."""
import io,json,re
from pathlib import Path
from PIL import Image,PngImagePlugin
from playwright.sync_api import sync_playwright,expect
expect.set_options(timeout=20000)
ROOT=Path(__file__).resolve().parents[1]
account={'username':'copy-transfer-test','role':'admin','quota':0,'used':0,'totalUsed':0,'remaining':None,'bannedUntil':0,'banned':False}
library=[{'id':'docy-local','category':'artist','name':'Docy','prompt':'artist:docy520','url':'https://example.com/docy'}, {'id':'example-local','category':'artist','name':'Example','prompt':'artist:example','url':'https://example.com/example'}, {'id':'collab-local','category':'quality','name':'Collab','prompt':'artist collaboration','url':'https://example.com/collab','defaultWeight':-5}]
buf=io.BytesIO();info=PngImagePlugin.PngInfo();info.add_text('Comment',json.dumps({'seed':12}));Image.new('RGB',(832,1216),'#abc').save(buf,format='PNG',pnginfo=info);png=buf.getvalue()

def prepare(browser,url,viewport=None):
    ctx=browser.new_context(viewport=viewport or {'width':1440,'height':1000},permissions=['clipboard-read','clipboard-write'],accept_downloads=True)
    if url.startswith('http://192.0.2.1'):
        # Keep the actual insecure IP origin; serve its assets locally so the test
        # does not depend on public-network access from the browser runner.
        def local_assets(route):
            target=route.request.url.replace('http://192.0.2.1','http://127.0.0.1:6006',1)
            route.fulfill(response=route.fetch(url=target))
        ctx.route('http://192.0.2.1/**',local_assets)
    ctx.route('**/api/auth/me',lambda r:r.fulfill(json={'account':account}))
    ctx.route('**/api/admin/prompts',lambda r:r.fulfill(json={'prompts':library}))
    ctx.route('**/api/status',lambda r:r.fulfill(json={'configured':True,'ready':True,'usagePercent':90,'account':account}))
    ctx.route('**/api/queue/*',lambda r:r.fulfill(json={'state':'running','position':0,'generating':True,'waiting':0,'capacity':5}))
    ctx.route('**/api/generate',lambda r:r.fulfill(body=png,content_type='image/png'))
    page=ctx.new_page();page.goto(url)
    return ctx,page

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    errors=[]
    # The test IP is an actual insecure origin: navigator.clipboard is unavailable.
    for url in ['http://127.0.0.1:6006','http://192.0.2.1']:
        ctx,page=prepare(browser,url);page.on('pageerror',lambda e:errors.append(str(e)));print('Clipboard origin:',url,'page:',page.url,flush=True)
        expect(page.get_by_label('提示词',exact=True)).to_be_visible()
        assert page.evaluate('isSecureContext')==(url.startswith('http://127.'))
        original='正向提示词\n1girl, 0.8::artist:"docy520"::'
        page.get_by_label('提示词',exact=True).fill(original)
        page.get_by_role('button',name='复制正向提示词',exact=True).click()
        expect(page.locator('.toast[role=status]')).to_contain_text('正向提示词已复制')
        reader=ctx.new_page();reader.goto('http://127.0.0.1:6006')
        assert reader.evaluate('navigator.clipboard.readText()')==original
        page.bring_to_front();page.get_by_role('button',name='生成图像',exact=True).click()
        expect(page.get_by_role('button',name='复制提示词',exact=True)).to_be_enabled()
        page.get_by_label('提示词',exact=True).fill('edited draft')
        page.get_by_role('button',name='复制正向提示词',exact=True).click()
        expect(page.locator('.toast[role=status]')).to_contain_text('正向提示词已复制')
        reader.bring_to_front();assert reader.evaluate('navigator.clipboard.readText()')=='edited draft'
        page.bring_to_front();page.get_by_role('button',name='复制提示词',exact=True).click()
        expect(page.locator('.toast[role=status]')).to_contain_text('已恢复图片设置，并复制正向提示词')
        # Current image settings restore through modularization; clipboard retains its raw positive frame text.
        reader.bring_to_front();assert reader.evaluate('navigator.clipboard.readText()')==original
        page.bring_to_front();expect(page.get_by_label('提示词',exact=True)).to_have_value(re.compile('正向提示词'))
        ctx.close()
    ctx,page=prepare(browser,'http://127.0.0.1:6006');page.on('pageerror',lambda e:errors.append(str(e)))
    page.locator('.module-library > summary').filter(has_text='添加画师串').click()
    page.get_by_role('button',name='Docy',exact=True).click();page.get_by_role('button',name='Example',exact=True).click()
    page.get_by_role('button',name='artist:docy520 权重加 0.1',exact=True).click()
    with page.expect_download() as download:
        page.get_by_role('button',name='导出画师串组合',exact=True).click()
    artist=json.loads(Path(download.value.path()).read_text())
    assert artist['category']=='artist' and artist['modules']==[{'prompt':'artist:docy520','weight':.9},{'prompt':'artist:example','weight':.8}]
    page.get_by_role('button',name='移除 artist:docy520',exact=True).click();page.get_by_role('button',name='移除 artist:example',exact=True).click()
    expect(page.get_by_role('button',name='导出画师串组合',exact=True)).to_be_disabled()
    page.get_by_label('导入画师串组合文件',exact=True).set_input_files({'name':'artist.json','mimeType':'application/json','buffer':json.dumps(artist).encode()})
    expect(page.get_by_label('artist:docy520 权重',exact=True)).to_have_text('0.9')
    expect(page.get_by_label('artist:example 权重',exact=True)).to_have_text('0.8')
    quality=page.locator('.prompt-module').filter(has=page.locator('summary').filter(has_text='质量风格'))
    quality.locator(':scope > summary').click()
    page.locator('.module-library > summary').filter(has_text='添加质量风格').click()
    page.get_by_role('button',name='Collab',exact=True).click()
    with page.expect_download() as download:
        page.get_by_role('button',name='导出质量风格组合',exact=True).click()
    styles=json.loads(Path(download.value.path()).read_text())
    assert styles['category']=='quality' and styles['modules'][-1]['weight']==-5
    page.get_by_role('button',name='移除 artist collaboration',exact=True).click()
    page.get_by_label('导入质量风格组合文件',exact=True).set_input_files({'name':'quality.json','mimeType':'application/json','buffer':json.dumps(styles).encode()})
    expect(page.get_by_label('artist collaboration 权重',exact=True)).to_have_text('-5.0')
    expect(page.get_by_label('artist:docy520 权重',exact=True)).to_have_text('0.9')
    page.get_by_label('导入画师串组合文件',exact=True).set_input_files({'name':'wrong.json','mimeType':'application/json','buffer':json.dumps(styles).encode()})
    expect(page.get_by_role('alert')).to_contain_text('质量风格')
    expect(page.get_by_label('artist:docy520 权重',exact=True)).to_have_text('0.9')
    for width,height in [(320,568),(390,844)]:
        page.set_viewport_size({'width':width,'height':height})
        page.get_by_role('button',name='提示词',exact=True).click()
        expect(page.get_by_role('button',name='导入画师串组合',exact=True)).to_be_visible()
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        page.get_by_role('button',name='关闭提示词面板',exact=True).click()
    ctx.close();browser.close()
    assert not errors,errors
    print('Copy and transfer passed: actual native/HTTP clipboard, frame copy and result copy, separate category files, order/weights/signs, template matching, invalid-file preservation, mobile.')
