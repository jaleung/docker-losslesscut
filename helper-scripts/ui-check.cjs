// Checks the background trimming views of the web page in a browser, and takes
//  screenshots. Used by smoke-test.sh, while a video is waiting (so that the
//  status box and the badge are shown).
//
// Usage: node ui-check.cjs URL OUT_DIR SWITCH(on|off) RECENT_TEXT WAITING_TEXT
//                           [PICK_TEXT PICK_FILE BLOCK NEW_NAME [PICK2_TEXT PICK2_FILE NEW_NAME2]]
//  - status box over LosslessCut: shows WAITING_TEXT    (08-status-box.png)
//  - badge on the side panel's tab: a click opens the panel on the Auto-trim
//    section, which shows SWITCH, RECENT_TEXT and WAITING_TEXT (07-side-panel.png)
//  - status page URL/autotrim (redirected to autotrim/): WAITING_TEXT, results
//    paged by 10 (09-status-page.png), its video renaming field: pasted line
//    breaks removed, "[]" back with the cursor inside when emptied or
//    cleared, check, copy, and with PICK_TEXT...: PICK_TEXT typed in the video
//    picker finds nothing (PICK_FILE is in a subfolder of /medias), then only
//    PICK_FILE with "Include subfolders" (remembered), picked with the
//    keyboard, "[BLOCK]" written,
//    NEW_NAME previewed, renamed after confirming (10-video-renaming.png,
//    11-rename-dialog.png); with PICK2_TEXT...: PICK2_FILE renamed to
//    NEW_NAME2 right away with "Rename without confirmation" (remembered).
//    Its dark mode switch (12-status-page-dark.png)
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

const [url, outDir, expectedSwitch, recentText, waitingText, pickText, pickFile, block, newName, pick2Text, pick2File, newName2] = process.argv.slice(2);
const forceOpen = process.env.UI_CHECK_FORCE_OPEN === '1';

function check(condition, message) {
    if (!condition) throw new Error(message);
}

(async () => {
    const browser = await playwright.chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    try {
        // Clipboard: for the Copy button of the video renaming field
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

        // Results: 10 per page
        const results = await statusPage.evaluate(async () => (await (await fetch('status?recent=all')).json()).recent.length);
        const pager = await statusPage.$eval('#autotrim_recent_pager', (p) => (p.classList.contains('d-none') ? '' : p.textContent));
        console.log(`  results: ${results}, pages: ${pager || 'one'}`);
        check(results > 10 ? pager.includes(`1–10 of ${results}`) : pager === '', `results pager: "${pager}" for ${results} results`);

        // Video renaming: the video picker has the focus on load, the field is
        //  "[]" with the cursor inside when focused
        check(await statusPage.evaluate(() => document.activeElement.id) === 'autotrim_video', 'the video picker has no focus on load');
        await statusPage.focus('#autotrim_scratch');
        const scratch = () => statusPage.$eval('#autotrim_scratch', (f) => ({
            value: f.value, caret: f.selectionStart, focused: document.activeElement === f,
        }));
        const scratchCheck = async () => (await statusPage.textContent('#autotrim_scratch_check')).trim();
        const paste = (text) => statusPage.$eval('#autotrim_scratch', (f, t) => {
            const data = new DataTransfer();
            data.setData('text/plain', t);
            f.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, text);
        await statusPage.waitForTimeout(100);
        let s = await scratch();
        check(s.value === '[]' && s.caret === 1 && s.focused, `video renaming field when focused: ${JSON.stringify(s)}`);
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

        // Pick a video, write the [...], rename it
        if (pickText) {
            await statusPage.click('#autotrim_scratch_clear');
            await statusPage.click('#autotrim_video');
            await statusPage.keyboard.type(pickText);
            // In a subfolder: only with "Include subfolders" (off by default)
            await statusPage.waitForFunction(() => document.getElementById('autotrim_video_list').textContent.includes('No video matches'),
                null, { timeout: 10000 });
            check(!(await statusPage.isChecked('#autotrim_video_subfolders')), '"Include subfolders" is on by default');
            await statusPage.click('#autotrim_video_subfolders');
            await statusPage.waitForFunction((file) => {
                const options = document.querySelectorAll('#autotrim_video_list [role="option"]');
                return options.length === 1 && options[0].title === file;
            }, pickFile, { timeout: 10000 });
            await statusPage.keyboard.press('Enter');
            const picked = await statusPage.evaluate(() => ({
                info: document.getElementById('autotrim_video_info').textContent, focused: document.activeElement.id,
            }));
            console.log(`  picked: ${picked.info}`);
            check(picked.info.startsWith(`${pickFile} · `) && picked.focused === 'autotrim_scratch', `picked: ${JSON.stringify(picked)}`);
            await statusPage.keyboard.type(block);
            await statusPage.waitForFunction((name) => !document.getElementById('autotrim_rename').disabled
                && document.getElementById('autotrim_rename_preview').textContent === `New name: ${name}`, newName, { timeout: 10000 });
            const cards = await Promise.all(['#autotrim_video_card', '#autotrim_scratch_card'].map((id) => statusPage.locator(id).boundingBox()));
            await statusPage.screenshot({
                path: `${outDir}/10-video-renaming.png`,
                clip: { x: cards[0].x, y: cards[0].y, width: cards[0].width, height: cards[1].y + cards[1].height - cards[0].y },
            });
            await statusPage.click('#autotrim_rename');
            await statusPage.waitForSelector('#autotrim_rename_dialog[open]');
            const dialog = await statusPage.evaluate(() => ({
                from: document.getElementById('autotrim_rename_from').textContent, to: document.getElementById('autotrim_rename_to').textContent,
            }));
            check(dialog.from === pickFile && dialog.to === newName, `rename dialog: ${JSON.stringify(dialog)}`);
            await statusPage.screenshot({ path: `${outDir}/11-rename-dialog.png` });
            await statusPage.click('#autotrim_rename_confirm');
            await statusPage.waitForFunction(() => !document.getElementById('autotrim_rename_dialog').open
                && document.getElementById('autotrim_rename_result').textContent.startsWith('✓ Renamed to'), null, { timeout: 10000 });
            const after = await statusPage.evaluate(() => ({
                result: document.getElementById('autotrim_rename_result').textContent,
                picker: document.getElementById('autotrim_video').value,
                field: document.getElementById('autotrim_scratch').value,
                focused: document.activeElement.id,
            }));
            console.log(`  ${after.result}`);
            check(after.result === `✓ Renamed to ${newName}` && after.picker === '' && after.field === '[]' && after.focused === 'autotrim_video',
                `after renaming: ${JSON.stringify(after)}`);
        }

        // Rename without confirmation
        if (pick2Text) {
            check(!(await statusPage.isChecked('#autotrim_rename_noconfirm')), '"Rename without confirmation" is on by default');
            await statusPage.click('#autotrim_rename_noconfirm');
            await statusPage.click('#autotrim_video');
            await statusPage.keyboard.type(pick2Text);
            await statusPage.waitForFunction((file) => {
                const options = document.querySelectorAll('#autotrim_video_list [role="option"]');
                return options.length === 1 && options[0].title === file;
            }, pick2File, { timeout: 10000 });
            await statusPage.keyboard.press('Enter');
            await statusPage.keyboard.type(block);
            await statusPage.waitForFunction((name) => !document.getElementById('autotrim_rename').disabled
                && document.getElementById('autotrim_rename_preview').textContent === `New name: ${name}`, newName2, { timeout: 10000 });
            await statusPage.click('#autotrim_rename');
            await statusPage.waitForFunction((name) => document.getElementById('autotrim_rename_result').textContent === `✓ Renamed to ${name}`,
                newName2, { timeout: 10000 });
            check(!(await statusPage.$eval('#autotrim_rename_dialog', (d) => d.open)), 'the dialog opened without confirmation');
            check(await statusPage.$eval('#autotrim_video', (f) => f.value) === '', 'the picker is not cleared after renaming');
            console.log(`  without confirmation: ✓ Renamed to ${newName2}`);
        }

        // Dark mode switch, remembered
        const theme = () => statusPage.evaluate(() => document.documentElement.getAttribute('data-bs-theme'));
        const initialTheme = await theme();
        await statusPage.click('#autotrim_theme');
        const switched = await theme();
        check(switched !== initialTheme, `theme still ${switched} after the switch`);
        await statusPage.reload();
        await statusPage.waitForSelector('#autotrim_theme');
        check(await theme() === switched, 'the theme is not remembered after a reload');
        if (pickText) check(await statusPage.isChecked('#autotrim_video_subfolders'), '"Include subfolders" is not remembered after a reload');
        if (pick2Text) check(await statusPage.isChecked('#autotrim_rename_noconfirm'), '"Rename without confirmation" is not remembered after a reload');
        if (switched !== 'dark') await statusPage.click('#autotrim_theme');
        check(await theme() === 'dark', 'no dark mode');
        await statusPage.screenshot({ path: `${outDir}/12-status-page-dark.png`, fullPage: true });
        console.log(`  theme: ${initialTheme}, switched to ${switched}, remembered`);

        if (errors.length > 0) console.log(`  page errors: ${errors.join(' | ')}`);
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error(`  ${err.message}`);
    process.exit(1);
});
