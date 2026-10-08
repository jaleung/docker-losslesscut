// "Auto-trim" section of the side panel: switch and status of the background
//  trimming of videos with segments in their name.
// API: /autotrim/ (nginx -> /opt/losslesscut-tools/autotrim.cjs)

(() => {
    'use strict';

    const API = 'autotrim/';
    const MAX_LISTED = 5;
    let ui;
    let timer;
    let available = true;

    const byId = (id) => document.getElementById(id);

    function build() {
        const settings = byId('settingsCollapse');
        const settingsItem = settings && settings.closest('li');
        if (!settingsItem) return false;
        const section = document.createElement('li');
        section.className = 'list-group-item d-none';
        section.id = 'autotrim_section';
        // Static markup only, file names are added as text
        section.innerHTML = `
            <label class="custom-accordion-button text-nowrap" data-bs-toggle="collapse" data-bs-target="#autotrimCollapse">Auto-trim</label>
            <div class="collapse show" id="autotrimCollapse">
                <div class="form-check form-switch mb-1">
                    <input class="form-check-input" type="checkbox" role="switch" id="autotrim_enabled">
                    <label class="form-check-label text-nowrap" for="autotrim_enabled">Trim in the background</label>
                </div>
                <div class="small text-muted mb-2" id="autotrim_status" style="max-width: 15rem;"></div>
                <div class="mb-2 d-none" id="autotrim_current" style="max-width: 15rem;">
                    <div class="small text-truncate" id="autotrim_current_name"></div>
                    <div class="progress" style="height: 6px;">
                        <div class="progress-bar" role="progressbar" id="autotrim_progress" style="width: 0%;"></div>
                    </div>
                    <div class="small text-muted" id="autotrim_step"></div>
                </div>
                <div class="d-none" id="autotrim_queue_section" style="max-width: 15rem;">
                    <div class="small fw-semibold">Waiting</div>
                    <ul class="list-unstyled small mb-2" id="autotrim_queue"></ul>
                </div>
                <div class="d-none" id="autotrim_recent_section" style="max-width: 15rem;">
                    <div class="small fw-semibold">Recent</div>
                    <ul class="list-unstyled small mb-1" id="autotrim_recent"></ul>
                </div>
                <button type="button" class="btn btn-outline-secondary btn-sm d-none" id="autotrim_retry">Retry failed</button>
            </div>`;
        settingsItem.parentNode.insertBefore(section, settingsItem);
        ui = {
            section,
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
        };
        ui.toggle.addEventListener('change', () => post('enabled', { enabled: ui.toggle.checked }));
        ui.retry.addEventListener('click', () => post('retry', {}));
        return true;
    }

    const show = (element, visible) => element.classList.toggle('d-none', !visible);

    function item(text, title, className) {
        const li = document.createElement('li');
        li.className = `text-truncate ${className || ''}`;
        li.textContent = text;
        if (title) li.title = title;
        return li;
    }

    function time(iso) {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function render(s) {
        show(ui.section, true);
        ui.toggle.checked = s.enabled;
        const folders = (s.folders || []).join(', ');
        if (!s.enabled) {
            ui.status.textContent = 'Off. When on, videos named like "[10-20,30-end]Name.mp4" are trimmed one at a time, and the source goes to the trash (like an export).';
        } else if (s.current) {
            ui.status.textContent = `On${folders ? `, watching ${folders}` : ''}.`;
        } else {
            const checked = s.lastScan ? ` Last check ${time(s.lastScan)}.` : '';
            ui.status.textContent = `On${folders ? `, watching ${folders}` : ''}. Nothing to trim.${checked}`;
        }

        show(ui.current, Boolean(s.current));
        if (s.current) {
            ui.currentName.textContent = s.current.name;
            ui.currentName.title = s.current.file;
            const pct = Math.round((s.current.progress || 0) * 100);
            ui.progress.style.width = `${pct}%`;
            ui.step.textContent = `${s.current.step || 'Trimming'}… ${pct}%`;
        }

        ui.queue.replaceChildren(...s.queue.slice(0, MAX_LISTED).map((q) => item(q.name, q.file)));
        if (s.queue.length > MAX_LISTED) ui.queue.append(item(`and ${s.queue.length - MAX_LISTED} more`, '', 'text-muted'));
        show(ui.queueSection, s.queue.length > 0);

        ui.recent.replaceChildren(...s.recent.slice(0, MAX_LISTED).map((r) => (r.ok
            ? item(`✓ ${r.outputName}`, `${time(r.at)}: ${r.name} → ${r.outputName}`, '')
            : item(`✗ ${r.name}: ${r.error}`, `${time(r.at)}: ${r.name}: ${r.error}`, 'text-danger'))));
        show(ui.recentSection, s.recent.length > 0);
        show(ui.retry, (s.failed || []).length > 0);
    }

    function schedule(s) {
        clearTimeout(timer);
        const active = s && s.enabled && (s.current || s.queue.length > 0);
        timer = setTimeout(refresh, !available ? 60000 : active ? 2000 : 10000);
    }

    async function request(path, options) {
        const res = await fetch(API + path, { cache: 'no-store', ...options });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function refresh() {
        let s;
        try {
            s = await request('status');
            available = true;
            render(s);
        } catch {
            // Disabled in the container (LOSSLESSCUT_AUTOTRIM=0) or not started yet
            available = false;
            show(ui.section, false);
        }
        schedule(s);
    }

    async function post(path, body) {
        ui.toggle.disabled = true;
        try {
            const s = await request(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            render(s);
            schedule(s);
        } catch (err) {
            ui.status.textContent = `Error: ${err.message}`;
            refresh();
        } finally {
            ui.toggle.disabled = false;
        }
    }

    function start() {
        if (!build()) return;
        refresh();
        // Up to date as soon as the page is visible again
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refresh();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
