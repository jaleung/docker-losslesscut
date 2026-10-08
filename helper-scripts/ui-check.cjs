// Checks the "Auto-trim" section of the side panel in a browser, and takes a
//  screenshot of the panel. Used by smoke-test.sh.
//
// Usage: node ui-check.cjs URL SCREENSHOT EXPECTED_SWITCH(on|off) [EXPECTED_TEXT]
//
// Needs playwright-core (or playwright) and Chrome/Chromium (CHROME_PATH, or
//  the browsers installed for Playwright).
// UI_CHECK_FORCE_OPEN=1 opens the panel without a VNC connection nor noVNC (to
//  test the page without a container).

'use strict';

let playwright;
try {
    playwright = require('playwright-core');
} catch {
    playwright = require('playwright');
}

const [url, screenshot, expectedSwitch, expectedText] = process.argv.slice(2);

(async () => {
    const browser = await playwright.chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.goto(url);
        if (process.env.UI_CHECK_FORCE_OPEN === '1') {
            await page.evaluate(() => {
                document.getElementById('noVNC_control_bar_anchor').classList.remove('noVNC_hidden');
                document.getElementById('noVNC_transition').style.display = 'none';
                document.getElementById('noVNC_control_bar').classList.add('noVNC_open');
            });
        }
        // The side panel's handle shows once connected to the VNC server
        await page.waitForSelector('#noVNC_control_bar_handle', { state: 'visible', timeout: 60000 });
        // First visit: the panel opens by itself and closes after 2s
        await page.waitForTimeout(3000);
        const bar = page.locator('#noVNC_control_bar');
        if (!await bar.evaluate((el) => el.classList.contains('noVNC_open'))) {
            await page.click('#noVNC_control_bar_handle');
        }
        await page.waitForSelector('#noVNC_control_bar.noVNC_open', { timeout: 10000 });
        await page.waitForSelector('#autotrim_section:not(.d-none)', { timeout: 20000 });
        // Let the CSS transition finish
        await page.waitForTimeout(1000);
        const checked = await page.isChecked('#autotrim_enabled');
        const text = await page.textContent('#autotrim_section');
        await bar.screenshot({ path: screenshot });
        console.log(`  switch: ${checked ? 'on' : 'off'}`);
        console.log(`  status: ${await page.textContent('#autotrim_status')}`);
        const recent = await page.$$eval('#autotrim_recent li', (items) => items.map((li) => li.textContent));
        if (recent.length > 0) console.log(`  recent: ${recent.join(' | ')}`);
        if (errors.length > 0) console.log(`  page errors: ${errors.join(' | ')}`);
        if ((expectedSwitch === 'on') !== checked) throw new Error(`switch is ${checked ? 'on' : 'off'}, expected ${expectedSwitch}`);
        if (expectedText && !text.includes(expectedText)) throw new Error(`"${expectedText}" not in the section`);
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error(`  ${err.message}`);
    process.exit(1);
});
