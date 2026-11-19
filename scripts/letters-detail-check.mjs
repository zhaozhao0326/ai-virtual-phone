/**
 * 信箱分级返回实测：打开一封信 → 返回应「收起信」→ 再返回应「退出信箱」。
 * 用真实坐标点击（会受遮挡影响，能测出状态栏这类"假按钮"问题）。
 *
 * 用法：node scripts/letters-detail-check.mjs [baseUrl]
 */
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || "http://127.0.0.1:3100";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (ok, name, extra = "") => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} | ${name}${extra ? " | " + extra : ""}`);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

async function enterPhone() {
    await page.evaluate(() => document.querySelector(".splash-enter-button")?.click());
    await sleep(2200);
    await page.evaluate(() => {
        [...document.querySelectorAll(".modal-overlay button")].forEach(btn => {
            const t = (btn.textContent || "").trim();
            if (t.includes("知道了")) btn.click();
        });
    });
    await sleep(600);
}

try {
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 90000 });
    await sleep(3200);
    await enterPhone();

    // 注入测试角色 + 一封测试信（信箱按角色分组，未知角色会被过滤）
    const seeded = await page.evaluate(async () => {
        const chars = JSON.stringify([{ id: "ui-test-char", name: "UI测试角色", avatar: "", persona: "测试用", signature: "", status: "", tags: [] }]);
        const openDb = (name, ver, onUp) => new Promise((res, rej) => {
            // ver 传 null 表示不指定版本：直接打开现有库（KvDB 实际版本会随端上升级）
            const req = ver ? indexedDB.open(name, ver) : indexedDB.open(name);
            req.onupgradeneeded = () => onUp(req.result);
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        });
        const kv = await openDb("AiPhoneKvDB", null, (d) => {
            if (!d.objectStoreNames.contains("entries")) d.createObjectStore("entries", { keyPath: "key" });
        });
        await new Promise((res, rej) => {
            const tx = kv.transaction("entries", "readwrite");
            tx.objectStore("entries").put({ key: "ai_phone_characters_v1", value: chars });
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
        const lb = await openDb("ai_phone_letters_db_v1", null, (d) => {
            if (!d.objectStoreNames.contains("letters")) {
                const st = d.createObjectStore("letters", { keyPath: "id" });
                st.createIndex("by_character", "characterId", { unique: false });
                st.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
            }
        });
        await new Promise((res, rej) => {
            const tx = lb.transaction("letters", "readwrite");
            tx.objectStore("letters").put({
                id: "ui-test-letter-1",
                characterId: "ui-test-char",
                from: "UI测试角色",
                content: "这是一封用于点击回归测试的信，用来验证读信时的返回分级。",
                createdAt: new Date().toISOString(),
                read: false,
                source: "manual",
                type: "letter",
            });
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
        return "ok";
    });
    log(seeded === "ok", "注入测试角色与测试信", seeded);

    // KvDB 内存缓存只在启动时水合，必须重载
    await page.reload({ waitUntil: "networkidle2", timeout: 90000 });
    await sleep(3200);
    await enterPhone();

    // 打开信箱
    const opened = await page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const find = t => [...document.querySelectorAll(".icon-item, .dock-item")].find(x => (x.textContent || "").trim().includes(t));
        let icon = find("信箱");
        if (!icon) {
            const dots = [...document.querySelectorAll(".page-controls .dot")];
            for (let i = 0; i < dots.length && !icon; i++) { dots[i].click(); await sleep(400); icon = find("信箱"); }
        }
        if (!icon) return "no-icon";
        icon.click();
        await sleep(1800);
        return "ok";
    });
    log(opened === "ok", "打开信箱", opened);

    const listed = await page.evaluate(() => document.body.innerText.includes("UI测试角色"));
    log(listed, "信件列表显示测试角色分组");

    // 点开这封信
    const openedLetter = await page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        // 列表条目是 button，文本是「新 + 内容摘要 + 日期」，按内容找最稳
        const btn = [...document.querySelectorAll('button')].find(n => (n.textContent || '').includes('点击回归测试') && n.getBoundingClientRect().height > 0);
        if (!btn) return 'no-item';
        btn.click();
        await sleep(900);
        const hasCollapse = [...document.querySelectorAll('button')].some(x => (x.textContent || '').trim() === '收起' && x.getBoundingClientRect().height > 0);
        return hasCollapse ? 'ok' : 'no-detail';
    });
    log(openedLetter === "ok", "点开一封信（详情出现）", openedLetter);

    const getBack = () => page.evaluate(() => {
        const el = [...document.querySelectorAll("[aria-label='返回']")].find(n => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(n).display !== "none";
        });
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        const nm = n => n ? `${n.tagName.toLowerCase()}.${(n.className || "").toString().split(" ").filter(Boolean).join(".")}` : "null";
        return { found: true, x, y, isSelf: top === el || el.contains(top), topEl: nm(top), y: Math.round(y) };
    });

    // 第一次返回：收起信，仍在信箱
    const back1 = await getBack();
    log(back1.found && back1.isSelf, "读信时返回键未被遮挡", `top=${back1.topEl} y=${back1.y}`);
    if (back1.found) {
        await page.mouse.click(back1.x, back1.y);
        await sleep(900);
        const state = await page.evaluate(() => {
            const hasCollapse = [...document.querySelectorAll("button")].some(x => (x.textContent || "").trim() === "收起" && x.getBoundingClientRect().height > 0);
            const inLetters = [...document.querySelectorAll("[aria-label='返回']")].some(n => n.getBoundingClientRect().height > 0);
            return { hasCollapse, inLetters };
        });
        log(!state.hasCollapse && state.inLetters, "第一次返回：收起信、仍在信箱", JSON.stringify(state));
    }

    // 第二次返回：退出信箱
    const back2 = await getBack();
    if (back2.found) {
        await page.mouse.click(back2.x, back2.y);
        await sleep(1200);
        const exited = await page.evaluate(() => {
            const backVisible = [...document.querySelectorAll("[aria-label='返回']")].some(n => n.getBoundingClientRect().height > 0);
            const dock = document.querySelector(".dock");
            return { backVisible, dockVisible: dock ? dock.getBoundingClientRect().height > 0 : false };
        });
        log(!exited.backVisible || exited.dockVisible, "第二次返回：退出信箱回到桌面", JSON.stringify(exited));
    }
} catch (e) {
    log(false, "脚本异常", e.message);
} finally {
    await browser.close();
}

const failed = results.filter(x => !x).length;
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
