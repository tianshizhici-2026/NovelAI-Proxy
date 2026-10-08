import re
"""Browser workflow checks. Generation is intercepted with a local PNG fixture."""
import base64
import io
import json
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=20000)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)

fixture = Image.new("RGB", (1024, 1024), "#252333")
ImageDraw.Draw(fixture).rectangle((256, 256, 768, 768), fill="#ac8cf6")
buffer = io.BytesIO()
fixture.save(buffer, format="PNG")
png = buffer.getvalue()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    context = browser.new_context(viewport={"width": 1600, "height": 1000})
    page = context.new_page()
    page.route('**/api/auth/me', lambda route: route.fulfill(json={'account': {'username': 'test-admin', 'role': 'admin', 'quota': 0, 'used': 0, 'totalUsed': 0, 'remaining': None, 'bannedUntil': 0, 'banned': False}}))
    page.route('**/api/admin/prompts', lambda route: route.fulfill(json={'prompts': []}))
    page.route("**/api/status", lambda route: route.fulfill(json={"configured": False, "ready": False, "message": "等待配置服务端 Token"}))
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://localhost:6006", wait_until="domcontentloaded")
    expect(page.locator(".service-hint")).to_have_text("等待配置服务端 Token")
    expect(page.get_by_role("button", name="生成图像", exact=True)).to_be_disabled()
    page.screenshot(path=str(ARTIFACTS / "desktop.png"), full_page=True)

    page.route("**/api/status", lambda route: route.fulfill(json={"configured": True, "ready": True, "usagePercent": 50, "message": "测试服务"}))
    requests = []

    def generated(route):
        requests.append(route.request.post_data_json)
        route.fulfill(body=png, content_type="image/png")

    page.route("**/api/generate", generated)
    page.locator(".connection-status").click()
    expect(page.locator(".connection-status")).to_contain_text("已连接")
    page.get_by_label("场景提示词", exact=True).fill("2girls, outdoors, soft lighting")
    page.get_by_label("负面提示词", exact=True).fill("blurry")
    page.get_by_label("添加角色", exact=True).click()
    page.get_by_label("角色 1 提示词", exact=True).fill("girl, silver hair")
    page.get_by_label("添加角色", exact=True).click()
    page.get_by_label("角色 2 提示词", exact=True).fill("girl, red hair")
    page.get_by_role("button", name="上移角色 2", exact=True).click()
    expect(page.get_by_label("角色 1 提示词", exact=True)).to_have_value("girl, red hair")
    page.get_by_label("角色位置", exact=True).select_option("custom")
    page.get_by_role("button", name="设置位置", exact=True).click()
    grid = page.locator(".position-grid").bounding_box()
    page.mouse.click(grid["x"] + grid["width"] * 0.25, grid["y"] + grid["height"] * 0.4)
    page.get_by_role("button", name="完成", exact=True).click()
    page.get_by_role("button", name=re.compile("^方图")).click()
    page.get_by_role("button", name="28", exact=True).click()
    page.get_by_label("Guidance 数值", exact=True).fill("6.5")
    page.get_by_role("button", name="生成图像", exact=True).click()
    expect(page.locator(".result-image img")).to_be_visible()
    assert requests[0]["steps"] == 28 and requests[0]["resolution"] == "square"
    assert requests[0]["guidance"] == 6.5 and requests[0]["mode"] == "generate"
    assert requests[0]["characters"][0]["x"] == 0.25
    assert not {"seed", "sampler", "model", "n_samples"} & requests[0].keys()
    expect(page.locator(".history-item")).to_have_count(1)

    page.get_by_role("button", name="继续重绘", exact=True).click()
    expect(page.get_by_label("重绘蒙版画布")).to_be_visible()
    expect(page.get_by_role("button", name="生成局部重绘", exact=True)).to_be_disabled()
    canvas = page.get_by_label("重绘蒙版画布").bounding_box()
    assert abs(canvas["width"] / canvas["height"] - 1) < 0.01
    page.mouse.move(canvas["x"] + canvas["width"] * 0.3, canvas["y"] + canvas["height"] * 0.4)
    page.mouse.down()
    page.mouse.move(canvas["x"] + canvas["width"] * 0.7, canvas["y"] + canvas["height"] * 0.5, steps=12)
    page.mouse.up()
    expect(page.get_by_role("button", name="生成局部重绘", exact=True)).to_be_enabled()
    page.get_by_role("button", name="撤销", exact=True).click()
    expect(page.get_by_role("button", name="生成局部重绘", exact=True)).to_be_disabled()
    page.get_by_role("button", name="重做", exact=True).click()
    expect(page.get_by_role("button", name="生成局部重绘", exact=True)).to_be_enabled()
    page.screenshot(path=str(ARTIFACTS / "inpaint.png"), full_page=True)
    page.get_by_label("重绘强度", exact=True).fill("0.55")
    page.get_by_role("button", name="生成局部重绘", exact=True).click()
    expect(page.locator(".history-item")).to_have_count(2)
    assert requests[1]["mode"] == "inpaint" and requests[1]["strength"] == 0.55
    mask = Image.open(io.BytesIO(base64.b64decode(requests[1]["mask"].split(",")[1])))
    assert mask.size == (1024, 1024)
    selection = mask.convert("L")
    assert selection.getpixel((307, 410)) == 255
    assert selection.getpixel((0, 0)) == 0
    # The browser retains brush coverage; the server thresholds on the 8px grid.
    assert any(0 < value < 255 for value in selection.getdata())
    page.reload(wait_until="domcontentloaded")
    expect(page.locator(".history-item")).to_have_count(2)
    expect(page.get_by_label("场景提示词", exact=True)).to_have_value("2girls, outdoors, soft lighting")
    with page.expect_download() as download:
        page.get_by_label("下载全部历史", exact=True).click()
    archive = zipfile.ZipFile(download.value.path())
    assert len(archive.namelist()) == 4

    page.get_by_role("button", name="继续重绘", exact=True).click()
    expect(page.get_by_label("重绘蒙版画布")).to_be_visible()
    page.get_by_label("上传重绘底图", exact=True).set_input_files({"name": "fixture.png", "mimeType": "image/png", "buffer": png})
    expect(page.get_by_label("重绘蒙版画布")).to_be_visible()
    for width, height in [(1280, 900), (1024, 768), (768, 1024), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(250)
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), f"overflow at {width}"
        canvas = page.get_by_label("重绘蒙版画布").bounding_box()
        assert abs(canvas["width"] / canvas["height"] - 1) < 0.01, f"distorted image at {width}"
    page.screenshot(path=str(ARTIFACTS / "mobile-inpaint.png"), full_page=True)
    page.locator(".mobile-nav").get_by_role("button", name="提示词", exact=True).click()
    expect(page.get_by_label("场景提示词", exact=True)).to_be_visible()
    page.get_by_label("场景提示词", exact=True).fill("mobile draft")
    page.get_by_label("关闭提示词面板", exact=True).click()
    page.locator(".mobile-nav").get_by_role("button", name="设置", exact=True).click()
    expect(page.get_by_label("Guidance 数值", exact=True)).to_be_visible()
    page.screenshot(path=str(ARTIFACTS / "mobile-settings.png"), full_page=True)
    page.get_by_label("关闭设置面板", exact=True).click()
    assert errors == [], errors
    print(json.dumps({"browser_errors": errors, "mock_generations": len(requests), "history_persists": True, "export_files": len(archive.namelist()), "responsive_sizes": 4}, ensure_ascii=False))
    browser.close()
