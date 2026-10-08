// Background trimming ("auto-trim") in the web page.
// - Main page: a section in the side panel (switch, status, queue, results), a
//   status box over LosslessCut while videos are trimmed or waiting, and a
//   badge on the side panel's tab
// - Status page (autotrim/, <body data-autotrim-page>): all of it, in full,
//   and a scratch pad to write the [...] of a file name
// API: autotrim/ (nginx -> /opt/losslesscut-tools/autotrim.cjs)

(() => {
    'use strict';

    //
    // Scratch pad helpers, without side effects (also run by the tests in Node)
    //

    // Pasted text without its line breaks: times copied from mpv often come
    //  with one (e.g. "968.968000 \r\n" from "echo ... | clip"). Each line is
    //  trimmed, empty ones are dropped, the others joined with a space
    function cleanPastedText(text) {
        if (!/[\r\n]/.test(text)) return text;
        return text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line !== '').join(' ');
    }

    // Seconds as h:mm:ss.mmm (m:ss.mmm under an hour)
    function formatTime(seconds) {
        const ms = Math.round(seconds * 1000);
        const pad = (n, width = 2) => String(n).padStart(width, '0');
        const h = Math.floor(ms / 3600000);
        const m = Math.floor(ms / 60000) % 60;
        const s = `${pad(Math.floor(ms / 1000) % 60)}${ms % 1000 ? `.${pad(ms % 1000, 3)}` : ''}`;
        return h > 0 ? `${h}:${pad(m)}:${s}` : `${m}:${s}`;
    }

    const PART = /^([0-9]+(?:\.[0-9]+)?)[ \t]*-[ \t]*([0-9]+(?:\.[0-9]+)?|end)$/;

    // Content of a [...] block, like "segments" in filename-segments:
    //  { segments: [{ start, end }] } (end undefined for "end"), or { error }
    function parseSpec(spec) {
        if (/[[\]]/.test(spec)) return { error: '[ or ] inside the brackets' };
        const parts = spec.split(',');
        const segments = [];
        for (const [i, raw] of parts.entries()) {
            const part = raw.toLowerCase().replace(/^[ \t]+|[ \t]+$/g, '');
            const label = `Part ${i + 1} "${raw.trim()}"`;
            if (part === '') {
                return { error: parts.length > 1 ? `Part ${i + 1} is empty (extra comma?)` : 'Nothing in the brackets' };
            }
            const match = PART.exec(part);
            if (!match) {
                return {
                    error: part.includes(':')
                        ? `${label}: times must be in seconds (e.g. 3725.5), not h:mm:ss`
                        : `${label}: write start-end in seconds, e.g. 10-20 or 30-end`,
                };
            }
            const start = Number(match[1]);
            const end = match[2] === 'end' ? undefined : Number(match[2]);
            if (end !== undefined && end <= start) return { error: `${label}: the end must be after the start` };
            segments.push({ start, end });
        }
        return { segments };
    }

    // Segments of a file name, like "parse" in filename-segments: the [...]
    //  block at the start of the name, else the one right before the extension
    function parseNameSegments(text) {
        let name = text.slice(text.lastIndexOf('/') + 1);
        // Strip the extension, unless the last "." is in the [...] block
        const dot = name.lastIndexOf('.');
        if (!/[[\]]/.test(name.slice(dot + 1)) && dot >= 0) name = name.slice(0, dot);
        let atStart;
        if (name.startsWith('[') && name.includes(']')) {
            atStart = parseSpec(name.slice(1, name.indexOf(']')));
            if (!atStart.error) return atStart;
        }
        if (name.endsWith(']') && name.includes('[')) {
            const atEnd = parseSpec(name.slice(name.lastIndexOf('[') + 1, -1));
            return atStart && atEnd.error ? atStart : atEnd;
        }
        return atStart || { error: 'No [...] at the start or the end' };
    }

    if (typeof document === 'undefined') {
        // Node: the tests
        module.exports = { cleanPastedText, formatTime, parseNameSegments };
        return;
    }

    const isPage = document.body.hasAttribute('data-autotrim-page');
    // Relative URLs: work behind a reverse proxy with a sub-path
    const API = isPage ? '' : 'autotrim/';
    const PAGE_URL = isPage ? './' : 'autotrim/';
    const MAX_LISTED = 5;
    const DONE_SHOWN_MS = 15000;

    //
    // Helpers
    //

    const byId = (id) => document.getElementById(id);

    // Element with attributes and children. Text is always set as text
    function el(tag, props = {}, ...children) {
        const element = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value == null) continue;
            if (key === 'class') element.className = value;
            else if (key === 'text') element.textContent = value;
            else if (key === 'style') element.style.cssText = value;
            else element.setAttribute(key, value);
        }
        element.append(...children.filter((c) => c != null && c !== ''));
        return element;
    }

    const show = (element, visible) => element.classList.toggle('d-none', !visible);

    // Settings of this browser (status box position, ...)
    const store = {
        get(key, fallback) {
            try {
                const value = localStorage.getItem(`autotrim.${key}`);
                return value == null ? fallback : JSON.parse(value);
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(`autotrim.${key}`, JSON.stringify(value));
            } catch {
                // Private browsing: not remembered
            }
        },
    };

    function time(iso) {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function timeLeft(seconds) {
        if (seconds == null) return '';
        if (seconds < 60) return 'less than a minute left';
        const min = Math.round(seconds / 60);
        return min < 60 ? `about ${min} min left` : `about ${Math.floor(min / 60)} h ${min % 60} min left`;
    }

    const percent = (s) => Math.round(((s.current && s.current.progress) || 0) * 100);

    function stepText(s) {
        const left = timeLeft(s.current.secondsLeft);
        return `${s.current.step || 'Trimming'}… ${percent(s)}%${left ? ` · ${left}` : ''}`;
    }

    // Everything not trimmed yet, in order, with what it's waiting for
    function waitingEntries(s) {
        return [
            ...(s.queue || []).map((q, i) => ({ ...q, label: i === 0 ? 'next' : '' })),
            ...(s.pending || []).map((p) => ({ ...p, label: p.reason === 'copying' ? 'copying' : 'checking', muted: true })),
            ...(s.waiting || []).map((w) => ({
                ...w, label: w.reason, muted: true, title: `${w.file}: ${w.reason}, not before ${time(w.until)}`,
            })),
        ];
    }

    const isActive = (s) => Boolean(s && s.enabled && (s.current || waitingEntries(s).length > 0));

    function statusText(s) {
        if (!s.enabled) {
            return 'Off. When on, videos named like "[10-20,30-end]Name.mp4" are trimmed one at a time, '
                + 'and cleaned up like after an export.';
        }
        const folders = (s.folders || []).join(', ');
        const idle = !isActive(s);
        const checked = idle && s.lastScan ? ` Last check ${time(s.lastScan)}.` : '';
        return `On${folders ? `, watching ${folders}` : ''}.${idle ? ' Nothing to trim.' : ''}${checked}`;
    }

    function summaryText(s) {
        const n = waitingEntries(s).length;
        if (s.current) return `${percent(s)}%${n ? ` · ${n} waiting` : ''}`;
        return `${n} waiting`;
    }

    function entryItem(entry, { truncate = true } = {}) {
        const li = el('li', { class: `${truncate ? 'text-truncate' : 'text-break'}${entry.muted ? ' text-muted' : ''}`, title: entry.title || entry.file });
        if (entry.label) li.append(el('span', { class: 'badge text-bg-secondary fw-normal me-1', text: entry.label }));
        li.append(entry.name);
        return li;
    }

    function resultItem(r, { truncate = true } = {}) {
        const cls = truncate ? 'text-truncate' : 'text-break';
        return r.ok
            ? el('li', { class: cls, title: `${time(r.at)}: ${r.name} → ${r.outputName}`, text: `✓ ${r.outputName}` })
            : el('li', { class: `${cls} text-danger`, title: `${time(r.at)}: ${r.name}: ${r.error}`, text: `✗ ${r.name}: ${r.error}` });
    }

    // Up to max items, then "and N more"
    function limited(items, max) {
        if (items.length <= max) return items;
        return [...items.slice(0, max), el('li', { class: 'text-muted', text: `and ${items.length - max} more` })];
    }

    //
    // Status, shared by the views
    //

    const views = [];
    let last;
    let available = true;
    let timer;

    async function request(path, options) {
        const res = await fetch(API + path, { cache: 'no-store', ...options });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    function render(s) {
        last = s;
        views.forEach((view) => view.render(s));
    }

    // Every 2s while trimming or waiting, 5s when on, 30s when off, paused while
    //  the page is hidden
    function schedule() {
        clearTimeout(timer);
        if (document.visibilityState === 'hidden') return;
        let delay = 5000;
        if (!available) delay = 60000;
        else if (!last || !last.enabled) delay = 30000;
        else if (isActive(last)) delay = 2000;
        timer = setTimeout(refresh, delay);
    }

    async function refresh() {
        clearTimeout(timer);
        try {
            const s = await request('status');
            available = true;
            render(s);
        } catch {
            // Disabled in the container (LOSSLESSCUT_AUTOTRIM=0) or not started yet
            available = false;
            views.forEach((view) => view.unavailable());
        }
        schedule();
    }

    async function post(path, body) {
        try {
            render(await request(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }));
        } catch (err) {
            views.forEach((view) => view.error && view.error(err));
            await refresh();
        }
        schedule();
    }

    //
    // Side panel section
    //

    let scrollToSection = false;

    function panelView() {
        const settings = byId('settingsCollapse');
        const settingsItem = settings && settings.closest('li');
        if (!settingsItem) return undefined;
        const section = el('li', { class: 'list-group-item d-none', id: 'autotrim_section' });
        // Static markup only, file names are added as text
        section.innerHTML = `
            <label class="custom-accordion-button text-nowrap" data-bs-toggle="collapse" data-bs-target="#autotrimCollapse">Auto-trim</label>
            <div class="collapse show" id="autotrimCollapse" style="max-width: 15rem;">
                <div class="form-check form-switch mb-1">
                    <input class="form-check-input" type="checkbox" role="switch" id="autotrim_enabled">
                    <label class="form-check-label text-nowrap" for="autotrim_enabled">Trim in the background</label>
                </div>
                <div class="small text-muted mb-2" id="autotrim_status"></div>
                <div class="mb-2 d-none" id="autotrim_current">
                    <div class="small text-truncate" id="autotrim_current_name"></div>
                    <div class="progress" style="height: 6px;">
                        <div class="progress-bar" role="progressbar" id="autotrim_progress" style="width: 0%;"></div>
                    </div>
                    <div class="small text-muted" id="autotrim_step"></div>
                </div>
                <div class="d-none" id="autotrim_queue_section">
                    <div class="small fw-semibold">Waiting</div>
                    <ul class="list-unstyled small mb-2" id="autotrim_queue"></ul>
                </div>
                <div class="d-none" id="autotrim_recent_section">
                    <div class="small fw-semibold">Recent</div>
                    <ul class="list-unstyled small mb-1" id="autotrim_recent"></ul>
                </div>
                <button type="button" class="btn btn-outline-secondary btn-sm d-none mb-1" id="autotrim_retry">Retry failed</button>
                <div class="small mb-2"><a target="_blank" rel="noopener" id="autotrim_page_link">Open full list</a></div>
                <div class="form-check form-switch mb-0">
                    <input class="form-check-input" type="checkbox" role="switch" id="autotrim_box_enabled">
                    <label class="form-check-label text-nowrap small" for="autotrim_box_enabled">Status box over LosslessCut</label>
                </div>
            </div>`;
        settingsItem.parentNode.insertBefore(section, settingsItem);
        const ui = {
            toggle: byId('autotrim_enabled'),
            status: byId('autotrim_status'),
            current: byId('autotrim_current'),
            currentName: byId('autotrim_current_name'),
            progress: byId('autotrim_progress'),
            step: byId('autotrim_step'),
            queueSection: byId('autotrim_queue_section'),
            queue: byId('autotrim_queue'),
            recentSection: byId('autotrim_recent_section'),
            recent: byId('autotrim_recent'),
            retry: byId('autotrim_retry'),
            boxToggle: byId('autotrim_box_enabled'),
        };
        byId('autotrim_page_link').href = PAGE_URL;
        ui.toggle.addEventListener('change', async () => {
            ui.toggle.disabled = true;
            await post('enabled', { enabled: ui.toggle.checked });
            ui.toggle.disabled = false;
        });
        ui.retry.addEventListener('click', () => post('retry', {}));
        ui.boxToggle.checked = store.get('box', true);
        ui.boxToggle.addEventListener('change', () => {
            store.set('box', ui.boxToggle.checked);
            if (last) render(last);
        });

        // Up to date as soon as the panel opens (it's hidden most of the time)
        const bar = byId('noVNC_control_bar');
        if (bar) {
            let open = bar.classList.contains('noVNC_open');
            new MutationObserver(() => {
                const nowOpen = bar.classList.contains('noVNC_open');
                if (nowOpen && !open) {
                    refresh();
                    if (scrollToSection) setTimeout(() => section.scrollIntoView({ block: 'nearest' }), 300);
                }
                if (nowOpen !== open) scrollToSection = false;
                open = nowOpen;
            }).observe(bar, { attributes: true, attributeFilter: ['class'] });
        }

        return {
            render(s) {
                show(section, true);
                ui.toggle.checked = s.enabled;
                ui.status.textContent = statusText(s);
                show(ui.current, Boolean(s.current));
                if (s.current) {
                    ui.currentName.textContent = s.current.name;
                    ui.currentName.title = s.current.file;
                    ui.progress.style.width = `${percent(s)}%`;
                    ui.step.textContent = stepText(s);
                }
                const waiting = waitingEntries(s).map((entry) => entryItem(entry));
                ui.queue.replaceChildren(...limited(waiting, MAX_LISTED));
                show(ui.queueSection, waiting.length > 0);
                ui.recent.replaceChildren(...s.recent.slice(0, MAX_LISTED).map((r) => resultItem(r)));
                show(ui.recentSection, s.recent.length > 0);
                show(ui.retry, (s.failed || []).length > 0);
            },
            unavailable() {
                show(section, false);
            },
            error(err) {
                ui.status.textContent = `Error: ${err.message}`;
            },
        };
    }

    //
    // Status box over LosslessCut
    //

    function boxView() {
        const icon = el('span', { class: 'autotrim-icon' });
        const summary = el('span', { class: 'autotrim-summary text-truncate text-muted' });
        const collapse = el('button', { type: 'button', class: 'btn btn-sm btn-link p-0 ms-auto text-reset text-decoration-none autotrim-collapse' });
        const header = el('div', { class: 'autotrim-header', title: 'Drag to move, double-click to put it back' },
            icon, el('strong', { text: 'Auto-trim' }), summary, collapse);
        const name = el('div', { class: 'text-truncate' });
        const bar = el('div', { class: 'progress-bar', role: 'progressbar', style: 'width: 0%;' });
        const step = el('div', { class: 'text-muted' });
        const current = el('div', { class: 'mb-1' }, name, el('div', { class: 'progress my-1', style: 'height: 6px;' }, bar), step);
        const done = el('div', { class: 'text-truncate mb-1' });
        const list = el('ul', { class: 'list-unstyled mb-1' });
        const listSection = el('div', {}, el('div', { class: 'fw-semibold', text: 'Waiting' }), list);
        const link = el('a', { href: PAGE_URL, target: '_blank', rel: 'noopener', text: 'Open full list' });
        const body = el('div', { class: 'autotrim-body' }, current, done, listSection, el('div', {}, link));
        const box = el('div', { class: 'autotrim-box d-none', id: 'autotrim_box', 'aria-label': 'Auto-trim status' }, header, body);
        document.body.append(box);

        // Keyboard focus stays in LosslessCut
        box.addEventListener('mousedown', (e) => {
            if (!e.target.closest('a')) e.preventDefault();
        });

        function setCollapsed(collapsed) {
            box.classList.toggle('autotrim-collapsed', collapsed);
            collapse.textContent = collapsed ? '▸' : '▾';
            collapse.title = collapsed ? 'Expand' : 'Collapse';
        }
        setCollapsed(store.get('boxCollapsed', false));
        collapse.addEventListener('click', () => {
            const collapsed = !box.classList.contains('autotrim-collapsed');
            store.set('boxCollapsed', collapsed);
            setCollapsed(collapsed);
            placeBox();
        });

        // Position: dragged by its header, remembered (fraction of the window)
        function placeBox() {
            const pos = store.get('boxPos', null);
            if (!pos) {
                box.style.left = '';
                box.style.top = '';
                box.style.right = '';
                return;
            }
            const maxX = Math.max(0, window.innerWidth - box.offsetWidth);
            const maxY = Math.max(0, window.innerHeight - box.offsetHeight);
            box.style.right = 'auto';
            box.style.left = `${Math.min(Math.max(0, pos.x * window.innerWidth), maxX)}px`;
            box.style.top = `${Math.min(Math.max(0, pos.y * window.innerHeight), maxY)}px`;
        }
        header.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('button')) return;
            const rect = box.getBoundingClientRect();
            const dx = e.clientX - rect.left;
            const dy = e.clientY - rect.top;
            header.setPointerCapture(e.pointerId);
            const move = (ev) => {
                box.style.right = 'auto';
                box.style.left = `${Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - rect.width)}px`;
                box.style.top = `${Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - rect.height)}px`;
            };
            const end = () => {
                header.removeEventListener('pointermove', move);
                header.removeEventListener('pointerup', end);
                header.removeEventListener('pointercancel', end);
                const r = box.getBoundingClientRect();
                store.set('boxPos', { x: r.left / window.innerWidth, y: r.top / window.innerHeight });
            };
            header.addEventListener('pointermove', move);
            header.addEventListener('pointerup', end);
            header.addEventListener('pointercancel', end);
            e.preventDefault();
        });
        header.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return;
            store.set('boxPos', null);
            placeBox();
        });
        window.addEventListener('resize', placeBox);

        // After the last trim, its result stays for a while
        let wasActive = false;
        let doneUntil = 0;
        let doneTimer;

        return {
            render(s) {
                const active = isActive(s);
                if (wasActive && !active && s.recent.length > 0) {
                    doneUntil = Date.now() + DONE_SHOWN_MS;
                    clearTimeout(doneTimer);
                    doneTimer = setTimeout(() => last && render(last), DONE_SHOWN_MS + 100);
                }
                wasActive = active;
                const showDone = s.enabled && !active && Date.now() < doneUntil;
                const visible = store.get('box', true) && (active || showDone);
                const wasHidden = box.classList.contains('d-none');
                show(box, visible);
                if (!visible) return;

                const failed = !active && s.recent[0] && !s.recent[0].ok;
                icon.replaceChildren();
                if (s.current) icon.append(el('span', { class: 'autotrim-spin' }));
                else if (active) icon.textContent = '⏳';
                else icon.textContent = failed ? '✗' : '✓';
                summary.textContent = active ? summaryText(s) : (failed ? 'failed' : 'done');
                show(current, Boolean(s.current));
                if (s.current) {
                    name.textContent = s.current.name;
                    name.title = s.current.file;
                    bar.style.width = `${percent(s)}%`;
                    step.textContent = stepText(s);
                }
                show(done, showDone);
                if (showDone) {
                    const r = s.recent[0];
                    done.replaceChildren(resultItem(r));
                }
                const waiting = waitingEntries(s).map((entry) => entryItem(entry));
                list.replaceChildren(...limited(waiting, MAX_LISTED));
                show(listSection, waiting.length > 0);
                if (wasHidden) placeBox();
            },
            unavailable() {
                show(box, false);
            },
        };
    }

    //
    // Badge on the side panel's tab
    //

    function badgeView() {
        const handle = byId('noVNC_control_bar_handle');
        if (!handle) return undefined;
        // Inside the tab: a click opens the side panel like a click on the tab
        const badge = el('span', { class: 'autotrim-badge d-none', id: 'autotrim_badge' });
        handle.append(badge);
        const goToSection = () => { scrollToSection = true; };
        badge.addEventListener('mousedown', goToSection);
        badge.addEventListener('touchstart', goToSection, { passive: true });

        return {
            render(s) {
                const visible = isActive(s);
                show(badge, visible);
                if (!visible) return;
                const n = waitingEntries(s).length;
                badge.replaceChildren();
                if (s.current) badge.append(el('span', { class: 'autotrim-spin' }), ` ${percent(s)}%${n ? ` +${n}` : ''}`);
                else badge.append(`⏳ ${n}`);
                badge.title = s.current
                    ? `Auto-trim: ${s.current.name}, ${stepText(s)}${n ? `, ${n} waiting` : ''}`
                    : `Auto-trim: ${n} waiting`;
            },
            unavailable() {
                show(badge, false);
            },
        };
    }

    //
    // Status page
    //

    // Scratch pad to write the [...] of a file name: line breaks of pasted
    //  times are removed, "[]" comes back with the cursor inside when emptied,
    //  and what's written is checked like filename-segments does
    function scratchPad() {
        const EMPTY = '[]';
        const field = el('input', {
            type: 'text', class: 'form-control font-monospace', id: 'autotrim_scratch',
            spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
            'aria-label': 'Scratch pad for the [...] of a file name', 'aria-describedby': 'autotrim_scratch_check',
        });
        const copy = el('button', { type: 'button', class: 'btn btn-outline-secondary', id: 'autotrim_scratch_copy', style: 'min-width: 5.5rem;', text: 'Copy' });
        const clear = el('button', { type: 'button', class: 'btn btn-outline-secondary', id: 'autotrim_scratch_clear', text: 'Clear' });
        const check = el('div', { class: 'form-text', id: 'autotrim_scratch_check' });

        const caretAt = (pos) => field.setSelectionRange(pos, pos);
        // At the cursor, in the field's undo history (Ctrl+Z)
        function insert(text) {
            if (!document.execCommand('insertText', false, text)) {
                field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
                field.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        function showCheck() {
            check.classList.remove('text-success-emphasis', 'text-danger-emphasis');
            if (/^(\[\s*\])?$/.test(field.value.trim())) {
                check.replaceChildren('Paste times in seconds from mpv, e.g. ', el('span', { class: 'text-nowrap', text: '[10-20,30-end]' }));
                return;
            }
            const result = parseNameSegments(field.value);
            if (result.error) {
                check.textContent = `✗ ${result.error}`;
                check.classList.add('text-danger-emphasis');
                return;
            }
            const n = result.segments.length;
            const parts = result.segments.map((s) => `${formatTime(s.start)} → ${s.end === undefined ? 'end' : formatTime(s.end)}`);
            check.textContent = `✓ ${n} part${n > 1 ? 's' : ''} to keep: ${parts.join(', ')}`;
            check.classList.add('text-success-emphasis');
        }
        // Empty: "[]" back, with the cursor inside
        function reset() {
            field.focus();
            field.select();
            insert(EMPTY);
            caretAt(1);
        }

        field.value = store.get('scratch', EMPTY) || EMPTY;
        showCheck();
        field.addEventListener('paste', (e) => {
            const text = e.clipboardData && e.clipboardData.getData('text/plain');
            if (text == null || !/[\r\n]/.test(text)) return;
            e.preventDefault();
            const cleaned = cleanPastedText(text);
            if (cleaned !== '') insert(cleaned);
        });
        field.addEventListener('input', (e) => {
            // Browsers remove line breaks from single-line fields, but not all
            //  of them for dropped text
            if (/[\r\n]/.test(field.value)) field.value = cleanPastedText(field.value);
            // Not when undoing: the next Ctrl+Z brings back what was deleted
            if (field.value === '' && !/^history/.test(e.inputType || '')) {
                reset();
                return;
            }
            store.set('scratch', field.value);
            showCheck();
        });
        // Into an empty "[]" (a click puts the cursor at the end)
        const caretInsideEmpty = () => {
            if (field.value === EMPTY) caretAt(1);
        };
        field.addEventListener('focus', () => setTimeout(caretInsideEmpty));
        field.addEventListener('click', caretInsideEmpty);
        clear.addEventListener('click', reset);

        let copyTimer;
        const showCopy = (text, style) => {
            copy.textContent = text;
            copy.classList.remove('btn-outline-secondary', 'btn-outline-success', 'btn-outline-danger');
            copy.classList.add(style);
        };
        copy.addEventListener('click', async () => {
            let copied = false;
            try {
                // HTTPS only (SECURE_CONNECTION)
                await navigator.clipboard.writeText(field.value);
                copied = true;
            } catch {
                const { selectionStart, selectionEnd } = field;
                field.focus();
                field.select();
                copied = document.execCommand('copy');
                field.setSelectionRange(selectionStart, selectionEnd);
            }
            if (copied) showCopy('Copied', 'btn-outline-success');
            else showCopy('Copy failed', 'btn-outline-danger');
            clearTimeout(copyTimer);
            copyTimer = setTimeout(() => showCopy('Copy', 'btn-outline-secondary'), 2000);
            field.focus();
        });

        return {
            element: el('section', { class: 'card mb-3', id: 'autotrim_scratch_card' }, el('div', { class: 'card-body' },
                el('h2', { class: 'h6 card-title', text: 'Scratch pad' }),
                el('div', { class: 'input-group' }, field, copy, clear),
                check)),
            // Ready to paste: the cursor before the closing "]"
            focus() {
                field.focus({ preventScroll: true });
                const close = field.value.lastIndexOf(']');
                caretAt(close >= 0 ? close : field.value.length);
            },
        };
    }

    function pageView() {
        const root = byId('autotrim_page');
        // Dark mode, like the main page
        fetch('../webdata.json', { cache: 'no-store' })
            .then((res) => res.json())
            .then((data) => {
                if (data.darkMode) document.documentElement.setAttribute('data-bs-theme', 'dark');
            })
            .catch(() => {});

        const toggle = el('input', { class: 'form-check-input', type: 'checkbox', role: 'switch', id: 'autotrim_page_enabled' });
        toggle.addEventListener('change', async () => {
            toggle.disabled = true;
            await post('enabled', { enabled: toggle.checked });
            toggle.disabled = false;
        });
        const status = el('p', { class: 'text-muted' });
        const header = el('div', { class: 'd-flex flex-wrap align-items-center gap-3 mb-2' },
            el('h1', { class: 'h4 mb-0 me-auto', text: 'Auto-trim' }),
            el('div', { class: 'form-check form-switch mb-0' }, toggle,
                el('label', { class: 'form-check-label', for: 'autotrim_page_enabled', text: 'Trim in the background' })),
            el('a', { href: '../', class: 'btn btn-sm btn-outline-secondary', text: 'Back to LosslessCut' }));

        const card = (title, ...children) => {
            const heading = el('h2', { class: 'h6 card-title', text: title });
            return { heading, element: el('section', { class: 'card mb-3' }, el('div', { class: 'card-body' }, heading, ...children)) };
        };
        const currentName = el('div', { class: 'text-break fw-semibold', id: 'autotrim_page_current' });
        const currentFile = el('div', { class: 'small text-muted text-break' });
        const bar = el('div', { class: 'progress-bar', role: 'progressbar', style: 'width: 0%;' });
        const step = el('div', { class: 'small text-muted' });
        const currentBody = el('div', {}, currentName, currentFile, el('div', { class: 'progress my-2', style: 'height: 1rem;' }, bar), step);
        const idle = el('p', { class: 'text-muted mb-0', text: 'Nothing is being trimmed.' });
        const currentCard = card('Trimming', currentBody, idle);
        const queue = el('ol', { class: 'mb-0 ps-4', id: 'autotrim_page_queue' });
        const noQueue = el('p', { class: 'text-muted mb-0', text: 'Nothing is waiting.' });
        const queueCard = card('Waiting', queue, noQueue);
        const recent = el('ul', { class: 'list-unstyled mb-0', id: 'autotrim_page_recent' });
        const noRecent = el('p', { class: 'text-muted mb-0', text: 'Nothing trimmed yet.' });
        const retry = el('button', { type: 'button', class: 'btn btn-outline-secondary btn-sm mt-2 d-none', text: 'Retry failed' });
        retry.addEventListener('click', () => post('retry', {}));
        const recentCard = card('Recent', recent, noRecent, retry);
        const scratch = scratchPad();
        root.replaceChildren(header, status, scratch.element, currentCard.element, queueCard.element, recentCard.element);
        scratch.focus();

        return {
            render(s) {
                toggle.checked = s.enabled;
                status.textContent = statusText(s);
                document.title = s.current ? `${percent(s)}% · Auto-trim - LosslessCut` : 'Auto-trim - LosslessCut';
                show(currentBody, Boolean(s.current));
                show(idle, !s.current);
                if (s.current) {
                    currentName.textContent = s.current.name;
                    currentFile.textContent = s.current.file;
                    bar.style.width = `${percent(s)}%`;
                    bar.textContent = `${percent(s)}%`;
                    step.textContent = stepText(s);
                }
                const waiting = waitingEntries(s);
                queueCard.heading.textContent = waiting.length > 0 ? `Waiting (${waiting.length})` : 'Waiting';
                queue.replaceChildren(...waiting.map((entry) => {
                    const li = entryItem(entry, { truncate: false });
                    li.append(el('div', { class: 'small text-muted text-break', text: entry.file }));
                    if (entry.until) li.append(el('div', { class: 'small text-muted', text: `Not before ${time(entry.until)}` }));
                    return li;
                }));
                show(queue, waiting.length > 0);
                show(noQueue, waiting.length === 0);
                recent.replaceChildren(...s.recent.map((r) => {
                    const li = resultItem(r, { truncate: false });
                    li.prepend(el('span', { class: 'text-muted me-2', text: time(r.at) }));
                    return li;
                }));
                show(recent, s.recent.length > 0);
                show(noRecent, s.recent.length === 0);
                show(retry, (s.failed || []).length > 0);
            },
            unavailable() {
                status.textContent = 'Background trimming isn\'t available (LOSSLESSCUT_AUTOTRIM=0, or still starting).';
            },
            error(err) {
                status.textContent = `Error: ${err.message}`;
            },
        };
    }

    //
    // Start
    //

    function addStyle() {
        document.head.append(el('style', { id: 'autotrim_style' }, `
            .autotrim-box {
                position: fixed; z-index: 9; top: 8px; right: 8px; width: 17rem; max-width: calc(100vw - 16px);
                background: var(--bs-body-bg); color: var(--bs-body-color);
                border: 1px solid var(--bs-border-color); border-radius: .5rem;
                box-shadow: 0 .25rem .75rem rgba(0, 0, 0, .3); font-size: .8125rem; opacity: .95;
            }
            .autotrim-header {
                display: flex; align-items: center; gap: .4rem; padding: .3rem .5rem;
                cursor: move; user-select: none; touch-action: none;
            }
            .autotrim-summary { min-width: 0; }
            .autotrim-body { padding: 0 .5rem .5rem; }
            .autotrim-collapsed .autotrim-body { display: none; }
            .autotrim-spin {
                display: inline-block; width: .75em; height: .75em; border: 2px solid currentColor;
                border-right-color: transparent; border-radius: 50%; animation: autotrim-spin .8s linear infinite;
            }
            @keyframes autotrim-spin { to { transform: rotate(360deg); } }
            .autotrim-badge {
                position: absolute; left: calc(100% + 4px); top: 50%; transform: translateY(-50%);
                padding: 1px 6px; border-radius: 10px; white-space: nowrap; font-size: 11px; line-height: 16px;
                background: var(--bs-primary); color: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
            }
            .noVNC_right .autotrim-badge { left: auto; right: calc(100% + 4px); }
            #noVNC_control_bar.noVNC_open .autotrim-badge { display: none; }
        `));
    }

    function start() {
        if (isPage) {
            views.push(pageView());
        } else {
            const panel = panelView();
            if (!panel) return;
            addStyle();
            views.push(panel, boxView(), badgeView());
        }
        for (let i = views.length - 1; i >= 0; i -= 1) if (!views[i]) views.splice(i, 1);
        refresh();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refresh();
            else clearTimeout(timer);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
