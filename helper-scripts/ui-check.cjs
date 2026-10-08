// Checks the background trimming views of the web page in a browser, and takes
//  screenshots. Used by smoke-test.sh, while a video is waiting (so that the
//  status box and the badge are shown).
//
// Usage: node ui-check.cjs URL OUT_DIR SWITCH(on|off) RECENT_TEXT WAITING_TEXT
//  - status box over LosslessCut: shows WAITING_TEXT    (08-status-box.png)
//  - badge on the side panel's tab: a click opens the panel on the Auto-trim
//    section, which shows SWITCH, RECENT_TEXT and WAITING_TEXT (07-side-panel.png)
//  - status page URL/autotrim (redirected to autotrim/): WAITING_TEXT
//    (09-status-page.png), and its scratch pad: pasted line breaks removed,
//    "[]" back with the cursor inside when emptied or cleared, check, copy
//    (10-scratch-pad.png)
//
// Needs playwright-core (or playwright) and Chrome/Chromium (CHROME_PATH, or
//  the browsers installed for Playwright).
// UI_CHECK_FORCE_OPEN=1: without a VNC connection nor noVNC (to test the page
//  without a container), the side panel is opened by hand.

'use strict';

let playwright;
try {
    playwright = require('playwright-core');
} catch {
    playwright = require('playwright');
}

const [url, outDir, expectedSwitch, recentText, waitingText] = process.argv.slice(2);
const forceOpen = process.env.UI_CHECK_FORCE_OPEN === '1';

function check(condition, message) {
    if (!condition) throw new Error(message);
}

(async () => {
    const browser = await playwright.chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    try {
        // Clipboard: for the Copy button of the scratch pad
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.goto(url);
        if (forceOpen) {
            await page.evaluate(() => {
                document.getElementById('noVNC_control_bar_anchor').classList.remove('noVNC_hidden');
                document.getElementById('noVNC_transition').style.display = 'none';
            });
        }
        // The side panel's tab shows once connected to the VNC server
        await page.waitForSelector('#noVNC_control_bar_handle', { state: 'visible', timeout: 60000 });
        // First visit: the panel opens by itself and closes after 2s
        await page.waitForTimeout(3000);
        const bar = page.locator('#noVNC_control_bar');
        if (await bar.evaluate((el) => el.classList.contains('noVNC_open'))) {
            await page.click('#noVNC_control_bar_handle');
            await page.waitForSelector('#noVNC_control_bar:not(.noVNC_open)', { timeout: 10000 });
        }

        // Status box and badge, panel closed
        await page.waitForSelector('#autotrim_box:not(.d-none)', { timeout: 20000 });
        await page.waitForFunction((text) => document.getElementById('autotrim_box').textContent.includes(text), waitingText, { timeout: 20000 });
        const boxText = (await page.textContent('#autotrim_box')).replace(/\s+/g, ' ').trim();
        console.log(`  status box: ${boxText}`);
        await page.waitForSelector('#autotrim_badge:not(.d-none)', { timeout: 10000 });
        console.log(`  badge: ${(await page.textContent('#autotrim_badge')).trim()} (${await page.getAttribute('#autotrim_badge', 'title')})`);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${outDir}/08-status-box.png` });

        // A click on the badge opens the side panel on the Auto-trim section
        if (forceOpen) await bar.evaluate((el) => el.classList.add('noVNC_open'));
        else await page.click('#autotrim_badge');
        await page.waitForSelector('#noVNC_control_bar.noVNC_open', { timeout: 10000 });
        await page.waitForSelector('#autotrim_section:not(.d-none)', { timeout: 20000 });
        await page.waitForTimeout(1000);
        const checked = await page.isChecked('#autotrim_enabled');
        const sectionText = await page.textContent('#autotrim_section');
        console.log(`  side panel: switch ${checked ? 'on' : 'off'}, ${await page.textContent('#autotrim_status')}`);
        console.log(`  waiting: ${(await page.$$eval('#autotrim_queue li', (items) => items.map((li) => li.textContent))).join(' | ')}`);
        console.log(`  recent: ${(await page.$$eval('#autotrim_recent li', (items) => items.map((li) => li.textContent))).join(' | ')}`);
        const inView = await page.locator('#autotrim_section').evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top < window.innerHeight && r.bottom > 0;
        });
        await bar.screenshot({ path: `${outDir}/07-side-panel.png` });
        check((expectedSwitch === 'on') === checked, `switch is ${checked ? 'on' : 'off'}, expected ${expectedSwitch}`);
        check(sectionText.includes(recentText), `"${recentText}" not in the side panel section`);
        check(sectionText.includes(waitingText), `"${waitingText}" not in the side panel section`);
        check(inView, 'the Auto-trim section is not in view');

        // Status page, also without the trailing slash
        const statusPage = await context.newPage();
        statusPage.on('pageerror', (err) => errors.push(err.message));
        await statusPage.goto(new URL('autotrim', url).href);
        check(statusPage.url().endsWith('/autotrim/'), `status page URL: ${statusPage.url()}`);
        await statusPage.waitForFunction((text) => {
            const queue = document.getElementById('autotrim_page_queue');
            return queue && queue.textContent.includes(text);
        }, waitingText, { timeout: 20000 });
        console.log(`  status page: ${(await statusPage.textContent('#autotrim_page')).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
        await statusPage.screenshot({ path: `${outDir}/09-status-page.png`, fullPage: true });

        // Scratch pad of the status page: ready on load, "[]" with the cursor inside
        const scratch = () => statusPage.$eval('#autotrim_scratch', (f) => ({
            value: f.value, caret: f.selectionStart, focused: document.activeElement === f,
        }));
        const scratchCheck = async () => (await statusPage.textContent('#autotrim_scratch_check')).trim();
        const paste = (text) => statusPage.$eval('#autotrim_scratch', (f, t) => {
            const data = new DataTransfer();
            data.setData('text/plain', t);
            f.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, text);
        let s = await scratch();
        check(s.value === '[]' && s.caret === 1 && s.focused, `scratch pad on load: ${JSON.stringify(s)}`);
        // Times copied from mpv, with their line break
        await paste('968.968000 \r\n');
        await statusPage.keyboard.type('-');
        await paste('1000.5\n');
        s = await scratch();
        console.log(`  scratch pad: ${s.value} (${await scratchCheck()})`);
        check(s.value === '[968.968000-1000.5]', `scratch pad after pasting: ${s.value}`);
        check((await scratchCheck()).startsWith('✓ 1 part to keep: 16:08.968 → 16:40.500'), `scratch pad check: ${await scratchCheck()}`);
        // Emptied: "[]" back, with the cursor inside
        await statusPage.keyboard.press('Control+A');
        await statusPage.keyboard.press('Backspace');
        s = await scratch();
        check(s.value === '[]' && s.caret === 1, `scratch pad emptied: ${JSON.stringify(s)}`);
        await statusPage.keyboard.type('5-2');
        console.log(`  scratch pad: [5-2] (${await scratchCheck()})`);
        check((await scratchCheck()).startsWith('✗ Part 1 "5-2"'), `scratch pad check of a mistake: ${await scratchCheck()}`);
        await statusPage.click('#autotrim_scratch_clear');
        s = await scratch();
        check(s.value === '[]' && s.caret === 1 && s.focused, `scratch pad cleared: ${JSON.stringify(s)}`);
        await statusPage.keyboard.type('0-end');
        await statusPage.click('#autotrim_scratch_copy');
        await statusPage.waitForFunction(() => document.getElementById('autotrim_scratch_copy').textContent === 'Copied', null, { timeout: 5000 });
        const clipboard = await statusPage.evaluate(() => navigator.clipboard.readText());
        check(clipboard === '[0-end]', `copied: ${JSON.stringify(clipboard)}`);
        await statusPage.locator('#autotrim_scratch_card').screenshot({ path: `${outDir}/10-scratch-pad.png` });

        if (errors.length > 0) console.log(`  page errors: ${errors.join(' | ')}`);
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error(`  ${err.message}`);
    process.exit(1);
});
