/**
 * 真机式点击回归：用本机 Chrome + 真实坐标点击（不是 element.click()，那样会绕过遮挡）。
 * 目的：验证 App 顶栏（返回键 / Tab）没有被状态栏之类的透明层吞掉点击。
 *
 * 用法：node scripts/ui-tap-check.mjs [baseUrl]
 */
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || "http://127.0.0.1:3100";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
function check(name, ok, extra = "") {
    results.push({ name, ok, extra });
    console.log(`${ok ? "PASS" : "FAIL"} | ${name}${extra ? " | " + extra : ""}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function hitTest(page, selector) {
    // 返回该元素中心点处「最上层」元素的描述，用于判断是否被遮挡
    return await page.evaluate((sel) => {
        // 同一 selector 可能命中隐藏的保活实例（height=0），只取真正可见的那个
        const all = [...document.querySelectorAll(sel)];
        const el = all.find(n => {
            const r = n.getBoundingClientRect();
            const s = getComputedStyle(n);
            return r.height > 0 && r.width > 0 && s.display !== "none" && s.visibility !== "hidden";
        });
        if (!el) return { found: false, reason: all.length ? "全部不可见" : "未找到" };
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        const describe = (n) => n ? `${n.tagName.toLowerCase()}.${(n.className || "").toString().split(" ").filter(Boolean).join(".")}` : "null";
        return {
            found: true,
            x, y,
            topEl: describe(top),
            isSelf: top === el || el.contains(top),
        };
    }, selector);
}

const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 90000 });
    await sleep(2500);

    // 关掉可能出现的引导/弹层
    await page.evaluate(() => {
        document.querySelectorAll("[class*='onboarding'] [class*='close'], [class*='guide'] button").forEach(b => b.click());
    });
    await sleep(500);

    // 0) 启动封面页（FLOAT）→ 点进入
    const entered = await page.evaluate(async () => {
        const btn = document.querySelector(".splash-enter-button");
        if (!btn) return "no-splash";
        btn.click();
        await new Promise(r => setTimeout(r, 1800));
        return "ok";
    });
    check("进入手机（封面页可进入）", entered === "ok" || entered === "no-splash", entered);
    await sleep(1500);

    // 关掉首次进入的改版公告等模态框（正常弹窗，会合法拦截点击）
    const modalClosed = await page.evaluate(() => {
        // 用真实按钮关闭（「我知道了」），不要手动 remove——会破坏 React 的 DOM 树导致后续渲染失败
        [...document.querySelectorAll(".modal-overlay button")].forEach(btn => {
            const t = (btn.textContent || "").trim();
            if (t.includes("我知道了") || t.includes("知道了") || t.includes("关闭")) btn.click();
        });
        return [...document.querySelectorAll(".modal-overlay")].filter(ov => {
            const s = getComputedStyle(ov);
            const r = ov.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && s.pointerEvents !== "none" && r.height > 100;
        }).length;
    });
    // 只做诊断输出：真正的判据是后面「能否点开 App / 顶栏是否被挡」
    console.log(`INFO | 关闭公告后仍存在的 modal-overlay：${modalClosed}（若不影响下方点击则无碍）`);

    // 1) 切到第 3 页并打开推特
    const opened = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const findIcon = (label) => [...document.querySelectorAll(".icon-item, .dock-item")]
            .find(b => (b.textContent || "").trim().includes(label));
        let icon = findIcon("推特");
        if (!icon) {
            const dots = [...document.querySelectorAll(".page-controls .dot")];
            if (dots.length >= 3) { dots[2].click(); await sleep(700); }
            icon = findIcon("推特");
        }
        if (!icon) return "no-icon";
        icon.click();
        await sleep(1200);
        return document.querySelector(".x-app") ? "ok" : "no-app";
    });
    check("打开推特 App", opened === "ok", opened);

    // 2) 返回键命中测试（关键）
    const backHit = await hitTest(page, ".x-back");
    check("返回键未被遮挡（elementFromPoint 指向自身）", backHit.found && backHit.isSelf,
        `top=${backHit.topEl} y=${Math.round(backHit.y ?? -1)}`);

    // 2b) 对照实验：把状态栏临时改回"会吃点击"的旧状态，应当复现遮挡
    const abTest = await page.evaluate(() => {
        const sb = document.querySelector(".phone-status-bar");
        if (!sb) return { skipped: true };
        const el = document.querySelector(".x-back");
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const name = (n) => n ? `${n.tagName.toLowerCase()}.${(n.className || "").toString().split(" ").filter(Boolean).join(".")}` : "null";
        // 旧状态
        sb.style.pointerEvents = "auto";
        [...sb.children].forEach(c => c.style.pointerEvents = "auto");
        const blockedTop = name(document.elementFromPoint(x, y));
        // 修复状态
        sb.style.pointerEvents = "";
        [...sb.children].forEach(c => c.style.pointerEvents = "");
        const fixedTop = name(document.elementFromPoint(x, y));
        return { skipped: false, blockedTop, fixedTop };
    });
    check("对照：旧行为确实被状态栏拦截（复现根因）",
        abTest.skipped || abTest.blockedTop.includes("phone-status-bar"),
        `旧=${abTest.blockedTop}`);
    check("对照：修复后点击穿透到 App",
        abTest.skipped || !abTest.fixedTop.includes("phone-status-bar"),
        `新=${abTest.fixedTop}`);

    // 3) 右上「我的」Tab 命中测试
    const myTabHit = await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".x-tabs button")].find(b => (b.textContent || "").includes("我的"));
        if (!btn) return { found: false };
        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
            found: true, x, y,
            isSelf: top === btn || btn.contains(top),
            topEl: top ? `${top.tagName.toLowerCase()}.${(top.className || "").toString().split(" ").filter(Boolean).join(".")}` : "null",
        };
    });
    check("右上「我的」Tab 未被遮挡", myTabHit.found && myTabHit.isSelf, `top=${myTabHit.topEl} y=${Math.round(myTabHit.y ?? -1)}`);

    // 4) 真实坐标点击「我的」，断言 Tab 真的切换
    if (myTabHit.found) {
        await page.mouse.click(myTabHit.x, myTabHit.y);
        await sleep(700);
        const switched = await page.evaluate(() => {
            const on = document.querySelector(".x-tabs button.on");
            return on ? (on.textContent || "").trim() : "";
        });
        check("真实点击「我的」后 Tab 切换生效", switched.includes("我的"), `active=${switched}`);
    }

    // 5) 真实坐标点击返回键，断言退回桌面
    if (backHit.found) {
        await page.mouse.click(backHit.x, backHit.y);
        await sleep(1200);
        const closed = await page.evaluate(() => !document.querySelector(".x-app") || getComputedStyle(document.querySelector(".x-app")).display === "none");
        check("真实点击返回键后退出推特", closed);
    }

    // 6) 泛化：塔罗 / 信箱 顶栏返回键是否同样可点（同一次修复应全部覆盖）
    const appCases = [
        { label: "塔罗", backSel: ".tarot-back", rootSel: ".tarot-app" },
        { label: "信箱", backSel: "[aria-label='返回']", rootSel: null },
    ];
    for (const c of appCases) {
        const openedApp = await page.evaluate(async (label) => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const findIcon = (t) => [...document.querySelectorAll(".icon-item, .dock-item")]
                .find(b => (b.textContent || "").trim().includes(t));
            let icon = findIcon(label);
            if (!icon) {
                const dots = [...document.querySelectorAll(".page-controls .dot")];
                for (let i = 0; i < dots.length && !icon; i++) { dots[i].click(); await sleep(400); icon = findIcon(label); }
            }
            if (!icon) return "no-icon";
            icon.click();
            await sleep(1200);
            return "ok";
        }, c.label);
        if (openedApp !== "ok") {
            console.log(`INFO | ${c.label} 未在桌面找到图标（跳过）`);
            continue;
        }
        const hit = await hitTest(page, c.backSel);
        check(`${c.label}：顶栏返回键未被遮挡`, hit.found && hit.isSelf, `top=${hit.topEl} y=${Math.round(hit.y ?? -1)}`);
        // 点一下退出，回到桌面
        if (hit.found) {
            await page.mouse.click(hit.x, hit.y);
            await sleep(900);
        }
    }
} catch (e) {
    check("脚本执行异常", false, e.message);
} finally {
    await browser.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
