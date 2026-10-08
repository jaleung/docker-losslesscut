// Checks the background trimming views of the web page in a browser, and takes
//  screenshots. Used by smoke-test.sh, while a video is waiting (so that the
//  status box and the badge are shown).
//
// Usage: node ui-check.cjs URL OUT_DIR SWITCH(on|off) RECENT_TEXT WAITING_TEXT
//  - status box over LosslessCut: shows WAITING_TEXT    (08-status-box.png)
//  - badge on the side panel's tab: a click opens the panel on the Auto-trim
//    section, which shows SWITCH, RECENT_TEXT and WAITING_TEXT (07-side-panel.png)
//  - status page URL/autotrim (redirected to autotrim/): WAITING_TEXT
//    (09-status-page.png)
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
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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

        if (errors.length > 0) console.log(`  page errors: ${errors.join(' | ')}`);
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error(`  ${err.message}`);
    process.exit(1);
});
