"""Check sampled/painted pixels and separate masks in both request modes, without upstream generation."""
import io, base64, json
from PIL import Image
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=15000)
buf = io.BytesIO()
image = Image.new('RGB', (832, 1216), '#080808'); image.paste('#b88a60', (0,0,416,1216)); image.save(buf, format='PNG')
source = buf.getvalue()
WHEAT = (184,138,96)

def decode(value):
    return Image.open(io.BytesIO(base64.b64decode(value.split(',')[1]))).convert('RGB')

def at(page, x, y):
    box = page.get_by_label('底图涂色画布', exact=True).bounding_box()
    return box['x'] + box['width']*x, box['y'] + box['height']*y

def stroke(page, x, y):
    x,y=at(page,x,y)
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+3,y+3,steps=3);page.mouse.up()

def paint_pixel(page, x=624, y=608):
    return page.get_by_label('底图涂色画布', exact=True).evaluate('(e,p) => [...e.getContext("2d").getImageData(p[0],p[1],1,1).data]',[x,y])

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1440,'height':1000},has_touch=True)
    page=context.new_page();submitted=[];errors=[]
    account={'username':'paint-test','role':'admin','quota':0,'used':0,'totalUsed':0,'remaining':None,'bannedUntil':0,'banned':False}
    page.route('**/api/auth/me', lambda r:r.fulfill(json={'account':account}))
    page.route('**/api/status', lambda r:r.fulfill(json={'configured':True,'ready':True,'usagePercent':90,'account':account}))
    page.route('**/api/admin/prompts', lambda r:r.fulfill(json={'prompts':[]}))
    page.route('**/api/queue/*', lambda r:r.fulfill(json={'state':'running','position':0,'generating':True,'waiting':0,'capacity':5}))
    def generate(r):
        body=r.request.post_data_json;submitted.append(body)
        r.fulfill(body=base64.b64decode(body['image'].split(',')[1]),content_type='image/png')
    page.route('**/api/generate',generate)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:6006')
    page.get_by_label('场景提示词',exact=True).fill('tan skin, tan lines')
    page.get_by_label('上传重绘底图',exact=True).set_input_files({'name':'paint.png','mimeType':'image/png','buffer':source})
    expect(page.get_by_alt_text('局部重绘底图',exact=True)).to_be_visible()
    page.wait_for_function('document.querySelector(".mask-artboard img").naturalWidth === 832')
    page.get_by_role('button',name='涂色',exact=True).click()
    page.get_by_role('button',name='取色',exact=True).click()
    page.mouse.click(*at(page,.25,.5))
    expect(page.get_by_label('涂色颜色',exact=True)).to_have_value('#b88a60')
    stroke(page,.75,.5)
    assert paint_pixel(page)==[*WHEAT,255]
    expect(page.get_by_role('button',name='生成局部重绘',exact=True)).to_be_disabled()
    page.get_by_role('button',name='撤销',exact=True).click();assert paint_pixel(page)[3]==0
    page.get_by_role('button',name='重做',exact=True).click();assert paint_pixel(page)==[*WHEAT,255]
    page.get_by_role('button',name='橡皮',exact=True).click();stroke(page,.75,.5);assert paint_pixel(page)[3]==0
    page.get_by_role('button',name='撤销',exact=True).click();assert paint_pixel(page)==[*WHEAT,255]
    page.get_by_role('button',name='蒙版',exact=True).click();stroke(page,.25,.5)
    # Ctrl+click samples the underlying wheat, despite the visible blue mask.
    page.keyboard.down('Control');page.mouse.click(*at(page,.25,.5));page.keyboard.up('Control')
    expect(page.get_by_label('涂色颜色',exact=True)).to_have_value('#b88a60')
    page.get_by_role('button',name='蒙版',exact=True).click();stroke(page,.75,.5)
    page.get_by_label('重绘 Strength 数值',exact=True).fill('0.25')
    page.get_by_role('button',name='生成局部重绘',exact=True).click()
    expect(page.get_by_role('button',name='继续重绘',exact=True)).to_be_enabled()
    body=submitted[-1];assert body['mode']=='inpaint' and body['strength']==.25
    exported=decode(body['image']);mask=decode(body['mask'])
    assert exported.getpixel((624,608))==WHEAT
    assert exported.getpixel((800,1100))==(8,8,8)
    assert mask.getpixel((624,608))==(255,255,255) and mask.getpixel((800,1100))==(0,0,0)
    page.get_by_role('button',name='图生图',exact=True).click()
    assert paint_pixel(page)==[*WHEAT,255]
    page.get_by_label('图生图 Strength 数值',exact=True).fill('0.2')
    page.get_by_role('button',name='生成 图生图',exact=True).click()
    expect(page.get_by_role('button',name='继续重绘',exact=True)).to_be_enabled()
    assert submitted[-1]['mode']=='img2img' and 'mask' not in submitted[-1]
    assert decode(submitted[-1]['image']).getpixel((624,608))==WHEAT
    page.get_by_role('button',name='局部重绘',exact=True).click()
    expect(page.get_by_role('button',name='生成局部重绘',exact=True)).to_be_enabled()
    assert paint_pixel(page)==[*WHEAT,255]
    page.get_by_role('button',name='涂色',exact=True).click()
    page.get_by_label('涂色透明度',exact=True).fill('0.5')
    page.get_by_role('button',name='图生图',exact=True).click()
    page.get_by_role('button',name='生成 图生图',exact=True).click()
    expect(page.get_by_role('button',name='继续重绘',exact=True)).to_be_enabled()
    blended=decode(submitted[-1]['image']).getpixel((624,608))
    assert all(abs(actual-(desired+8)/2)<=1 for actual,desired in zip(blended,WHEAT)),blended
    page.get_by_role('button',name='局部重绘',exact=True).click()
    page.get_by_role('button',name='涂色',exact=True).click()
    for width,height in [(320,568),(390,844)]:
        page.set_viewport_size({'width':width,'height':height})
        expect(page.get_by_role('button',name='取色',exact=True)).to_be_visible()
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        before=page.locator('.paint-layer-controls').bounding_box()
        page.get_by_role('button',name='放大画布',exact=True).click()
        assert page.locator('.paint-layer-controls').bounding_box()==before
        page.get_by_role('button',name='适应画布',exact=True).click()
    page.screenshot(path='artifacts/novelai-paint-mobile.png')
    page.get_by_role('button',name='清空涂色',exact=True).click();assert paint_pixel(page)[3]==0
    page.get_by_role('button',name='撤销',exact=True).click();assert paint_pixel(page)==[*WHEAT,255]
    # Resizing intentionally starts a fresh editor for correctly sized source/mask.
    page.get_by_role('button',name='设置',exact=True).click()
    page.get_by_role('button',name='方图',exact=False).first.click()
    page.get_by_role('button',name='关闭设置面板',exact=True).click()
    expect(page.get_by_label('底图涂色画布',exact=True)).to_have_attribute('width','1024')
    page.wait_for_function('document.querySelector("[aria-label=底图涂色画布]").getContext("2d").getImageData(624,608,1,1).data[3]===0')
    assert not errors,errors
    browser.close()
    print('Paint UI passed: eyedropper excludes mask, color/eraser/undo, separate binary mask, actual request pixels, mode reuse, opacity, mobile/zoom, resize reset.')
