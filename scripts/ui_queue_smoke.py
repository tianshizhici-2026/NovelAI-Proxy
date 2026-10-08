"""Queue UI checks with intercepted APIs and PNG responses; no upstream generation."""
import asyncio
import io
from pathlib import Path
from PIL import Image
from playwright.async_api import async_playwright, expect

expect.set_options(timeout=15000)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)
buffer = io.BytesIO()
Image.new('RGB', (1024, 1024), '#f2d0e0').save(buffer, format='PNG')
image = buffer.getvalue()
account = {'username': 'preview-admin', 'role': 'admin', 'quota': 0, 'used': 0, 'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = await context.new_page()
        errors, ids, submitted = [], [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.route('**/api/auth/me', lambda route: route.fulfill(json={'account': account}))
        await page.route('**/api/admin/prompts', lambda route: route.fulfill(json={'prompts': []}))
        await page.route('**/api/status', lambda route: route.fulfill(json={'configured': True, 'ready': True, 'usagePercent': 91, 'message': '已连接', 'account': account}))
        finish = asyncio.Event()
        job = {'state': 'waiting', 'position': 3, 'generating': True, 'waiting': 3, 'capacity': 5}
        full = False

        async def generated(route):
            ids.append(route.request.headers['x-generation-id'])
            submitted.append(route.request.post_data_json)
            if full:
                await route.fulfill(status=409, json={'error': '已有生成任务正在处理，等待队列已满（5 张），请稍后再试。', 'code': 'BUSY'})
            else:
                await finish.wait()
                await route.fulfill(body=image, content_type='image/png')

        await page.route('**/api/generate', generated)
        await page.route('**/api/queue/*', lambda route: route.fulfill(json=job))
        await page.goto('http://127.0.0.1:6006')
        await page.get_by_label('场景提示词', exact=True).fill('forest')
        await page.get_by_role('button', name='生成图像', exact=True).click()
        await expect(page.locator('.generate-button')).to_contain_text('排队中 · 第 3 位')
        await expect(page.locator('.working-overlay strong')).to_have_text('排队中 · 第 3 位')
        assert len(ids) == 1
        await expect(page.get_by_label('场景提示词', exact=True)).to_be_enabled()
        await page.get_by_label('场景提示词', exact=True).fill('next scene')
        await expect(page.get_by_label('负面提示词', exact=True)).to_be_enabled()
        await page.get_by_label('负面提示词', exact=True).fill('next negative')
        await expect(page.get_by_label('添加角色', exact=True)).to_be_enabled()
        assert submitted[0]['prompt'] == 'forest', submitted[0]
        await page.screenshot(path=str(ARTIFACTS / 'novelai-queue-desktop.png'))
        job['position'] = 1
        await expect(page.locator('.generate-button')).to_contain_text('排队中 · 第 1 位')
        job.update(state='running', position=0)
        await expect(page.locator('.generate-button')).to_contain_text('正在生成…')
        finish.set()
        await expect(page.get_by_alt_text('当前生成结果', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='生成图像', exact=True)).to_be_enabled()
        await expect(page.get_by_label('场景提示词', exact=True)).to_have_value('next scene')
        assert len(ids) == 1, 'polling must not resubmit the job'
        full = True
        await page.get_by_role('button', name='生成图像', exact=True).click()
        await expect(page.locator('.toast')).to_contain_text('等待队列已满（5 张），请稍后再试')
        await expect(page.get_by_role('button', name='生成图像', exact=True)).to_be_enabled()
        await expect(page.locator('.history-item')).to_have_count(1)
        full = False
        finish.clear()
        job.update(state='waiting', position=2)
        await page.set_viewport_size({'width': 390, 'height': 844})
        await page.locator('.mobile-generate').click()
        await expect(page.locator('.mobile-generate')).to_have_text('排队 2')
        await expect(page.locator('.working-overlay strong')).to_have_text('排队中 · 第 2 位')
        assert not await page.evaluate('document.documentElement.scrollWidth > innerWidth')
        await page.screenshot(path=str(ARTIFACTS / 'novelai-queue-mobile.png'))
        finish.set()
        await expect(page.locator('.mobile-generate')).to_have_text('生成')
        await expect(page.locator('.mobile-generate')).to_be_enabled()
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        await expect(page.locator('.history-item')).to_have_count(2)
        assert len(ids) == 3 and len(set(ids)) == 3
        assert not errors, errors
        await browser.close()
        print('Queue UI passed: desktop/mobile position updates, automatic generation, queue-full message, no duplicate submissions.')


asyncio.run(main())
