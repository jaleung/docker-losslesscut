// Tests of rootfs/opt/losslesscut-tools/autotrim.cjs (background trimming):
//  the parts without side effects. Run with node, see test-scripts.sh

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const at = require(path.join(root, 'rootfs/opt/losslesscut-tools/autotrim.cjs'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
// args contains the expected values next to each other
const includesInOrder = (args, ...expected) => args.some((_, start) => expected.every((e, i) => args[start + i] === e));

console.log('Background trimming (autotrim.cjs)');

test('LosslessCut project file (JSON5)', () => {
    const project = at.parseJson5(`{
  version: 2,
  mediaFileName: '[0-10]it\\'s.mp4',
  // comment
  cutSegments: [
    { start: 1, end: 4.5, name: '', selected: true, },
    { start: .5, end: +6, name: "x", selected: false },
  ],
}`);
    assert.equal(project.mediaFileName, "[0-10]it's.mp4");
    assert.deepEqual(project.cutSegments.map((s) => [s.start, s.end, s.selected]), [[1, 4.5, true], [0.5, 6, false]]);
    assert.deepEqual(at.parseJson5('{"a": [1, -2e3, null, true, "\\u00e9"]}'), { a: [1, -2000, null, true, 'é'] });
    assert.throws(() => at.parseJson5('{ a: 1 '));
    assert.throws(() => at.parseJson5('{ a: process.exit() }'));
    assert.equal(Object.getPrototypeOf(at.parseJson5('{ "__proto__": { "x": 1 } }')), Object.prototype);
});

test('generated project file (JSON) is read the same way', () => {
    const generated = '{\n  "version": 2,\n  "generatedBy": "docker-losslesscut filename-segments",\n  "cutSegments": [\n    { "start": 2, "end": 5, "name": "" }\n  ]}\n';
    assert.deepEqual(at.parseJson5(generated).cutSegments, [{ start: 2, end: 5, name: '' }]);
});

test('segments to keep', () => {
    assert.deepEqual(at.normalizeSegments([
        { start: 2, end: 5 },
        { start: 6, end: 8, selected: false },
        { start: 9 }, // marker
        { start: 15, end: 30 }, // past the end
        { start: 40, end: 50 }, // after the end
        { end: 1 }, // no start: from the beginning
    ], 20), [{ start: 2, end: 5 }, { start: 15, end: 20 }, { start: 0, end: 1 }]);
});

test('output format', () => {
    const mp4 = 'mov,mp4,m4a,3gp,3g2,mj2';
    const f = (formatName, ext, streams = []) => at.getOutFormat({ formatName, ext, streams });
    assert.equal(f(mp4, '.mp4'), 'mp4');
    assert.equal(f(mp4, '.MOV'), 'mov');
    assert.equal(f(mp4, '.m4a'), 'ipod');
    assert.equal(f('matroska,webm', '.webm'), 'webm');
    assert.equal(f('matroska,webm', '.mkv'), 'matroska');
    assert.equal(f('aac', '.aac'), 'adts');
    assert.equal(f('mpegts', '.ts'), 'mpegts');
    assert.equal(f(mp4, '.mp4', [{ codec_name: 'pcm_s16le' }]), 'mov');
});

const streams = [
    { index: 0, codec_type: 'video', codec_name: 'h264', disposition: { default: 1 } },
    { index: 1, codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', disposition: { default: 0, forced: 1 } },
    { index: 3, codec_type: 'data', codec_name: 'none', codec_tag_string: 'tmcd' },
];

test('cut arguments (like LosslessCut\'s keyframe cut)', () => {
    const args = at.getCutArgs({ input: 'in.mp4', output: 'out.mp4', start: 2, end: 5, duration: 20, streams, outFormat: 'mp4' });
    assert.ok(includesInOrder(args, '-ss', '2', '-i', 'in.mp4', '-t', '3', '-avoid_negative_ts', 'make_zero'), args.join(' '));
    assert.ok(includesInOrder(args, '-map', '0:0', '-c:0', 'copy', '-map', '0:1', '-c:1', 'copy', '-map', '0:2', '-c:2', 'mov_text'), args.join(' '));
    assert.ok(!args.includes('0:3'), 'data stream (timecode) not copied');
    assert.ok(includesInOrder(args, '-map_metadata', '0', '-movflags', '+faststart'));
    assert.ok(includesInOrder(args, '-f', 'mp4', '-y', 'out.mp4'));
    const whole = at.getCutArgs({ input: 'in.mp4', output: 'out.mp4', start: 0, end: 20, duration: 20, streams, outFormat: 'mp4' });
    assert.ok(!whole.includes('-ss') && !whole.includes('-t') && !whole.includes('-avoid_negative_ts'), whole.join(' '));
    const mkv = at.getCutArgs({ input: 'in.mkv', output: 'o.mkv', start: 0, end: 3, duration: 20, streams, outFormat: 'matroska' });
    assert.ok(includesInOrder(mkv, '-map', '0:2', '-c:2', 'copy'), 'subtitles copied as they are in MKV');
});

test('merge arguments', () => {
    const args = at.getMergeArgs({ output: 'out.mp4', streams, outFormat: 'mp4' });
    assert.ok(includesInOrder(args, '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe,fd', '-i', '-'));
    assert.ok(includesInOrder(args, '-map', '0:2', '-c:2', 'copy', '-disposition:2', 'forced'), args.join(' '));
    assert.equal(at.getConcatList(['/a/b.mp4', "/a/it's.mp4"]), "file 'file:/a/b.mp4'\nfile 'file:/a/it'\\''s.mp4'");
});

test('output names', () => {
    const defaults = JSON.parse(fs.readFileSync(path.join(root, 'rootfs/defaults/losslesscut-settings.json'), 'utf8'));
    const name = (losslessCutConfig, file, segments) => at.getOutputName({ losslessCutConfig, file, ext: path.extname(file), segments, epochMs: 1234 });
    const two = [{ start: 2, end: 5 }, { start: 8, end: 20 }];
    const one = [{ start: 2, end: 5 }];
    assert.equal(name(defaults, '/m/[0-968.968000,2080.078000-end]new video.mp4', two), 'NEW VIDEO-trimmed.mp4');
    assert.equal(name(defaults, '/m/New Video[1-2].mkv', one), 'NEW VIDEO-trimmed.mkv');
    // LosslessCut's own defaults without the image's settings
    assert.equal(name({}, '/m/clip[2-5].mp4', one), 'clip[2-5]-00.00.02.000-00.00.05.000.mp4');
    assert.equal(name({}, '/m/clip[2-5,8-9].mp4', two), 'clip[2-5,8-9]-cut-merged-1234.mp4');
    // Broken templates, or the source's own name: LosslessCut's default instead
    assert.equal(name({ mergedFileTemplate: '${NOPE}' }, '/m/c[1-2,3-4].mp4', two), 'c[1-2,3-4]-cut-merged-1234.mp4');
    assert.equal(name({ outSegTemplate: '${FILENAME}${EXT}' }, '/m/c[1-2].mp4', one), 'c[1-2]-00.00.02.000-00.00.05.000.mp4');
    assert.equal(name({ outSegTemplate: '../${FILENAME}${EXT}' }, '/m/c[1-2].mp4', one), 'c[1-2]-00.00.02.000-00.00.05.000.mp4');
});

test('cleanup follows LosslessCut\'s settings', () => {
    const defaults = JSON.parse(fs.readFileSync(path.join(root, 'rootfs/defaults/losslesscut-settings.json'), 'utf8'));
    assert.deepEqual(at.getCleanup(defaults.cleanupChoices), { trashSource: true, trashProject: true, deleteIfTrashFails: true });
    assert.deepEqual(at.getCleanup(undefined), { trashSource: false, trashProject: false, deleteIfTrashFails: false });
    assert.equal(at.getCleanup({ ...defaults.cleanupChoices, askForCleanup: true }).trashSource, false, 'asking: can\'t ask in the background');
    assert.equal(at.getCleanup({ ...defaults.cleanupChoices, cleanupAfterExport: false }).trashSource, false);
    assert.equal(at.getCleanup({ ...defaults.cleanupChoices, trashSourceFile: false }).trashSource, false);
});

test('never overwrite: " (2)" added', async () => {
    const existing = new Set(['/m/A-trimmed.mp4', '/m/A-trimmed (2).mp4']);
    const exists = async (f) => existing.has(f);
    assert.equal(await at.uniquePath('/m/B-trimmed.mp4', exists), '/m/B-trimmed.mp4');
    assert.equal(await at.uniquePath('/m/A-trimmed.mp4', exists), '/m/A-trimmed (3).mp4');
});

test('copies in progress are not picked', () => {
    const now = 100000;
    const st = { size: 10, mtimeMs: now - 40000 };
    assert.equal(at.isSettled({ previous: undefined, current: st, now, settleMs: 30000 }), false, 'first time seen');
    assert.equal(at.isSettled({ previous: st, current: st, now, settleMs: 30000 }), true);
    assert.equal(at.isSettled({ previous: { size: 5, mtimeMs: st.mtimeMs }, current: st, now, settleMs: 30000 }), false, 'grew');
    const fresh = { size: 10, mtimeMs: now - 1000 };
    assert.equal(at.isSettled({ previous: fresh, current: fresh, now, settleMs: 30000 }), false, 'modified 1s ago');
});

test('videos being edited in LosslessCut wait', () => {
    const now = 1000000;
    const quietMs = 600000;
    const generated = '{\n  "version": 2,\n  "generatedBy": "docker-losslesscut filename-segments",\n  "cutSegments": []}';
    const saved = "{\n  version: 2,\n  mediaFileName: 'x.mp4',\n  cutSegments: [],\n}";
    assert.equal(at.isBeingEdited({ projectText: saved, projectMtimeMs: now - 60000, now, quietMs }), true, 'saved by LosslessCut 1 min ago');
    assert.equal(at.isBeingEdited({ projectText: saved, projectMtimeMs: now - 700000, now, quietMs }), false, 'quiet for 11 min');
    assert.equal(at.isBeingEdited({ projectText: generated, projectMtimeMs: now - 1000, now, quietMs }), false, 'generated, not opened');
    assert.equal(at.isBeingEdited({ projectText: undefined, projectMtimeMs: now, now, quietMs }), false, 'no project file');
    // The generator's marker, as written by filename-segments
    const script = fs.readFileSync(path.join(root, 'rootfs/opt/losslesscut-tools/filename-segments'), 'utf8');
    assert.match(script, /"generatedBy": "%s"/);
    assert.match(script, /^MARKER="docker-losslesscut filename-segments"$/m);
});

test('time left', () => {
    assert.equal(at.estimateSecondsLeft({ progress: 0.25, elapsedMs: 30000 }), 90);
    assert.equal(at.estimateSecondsLeft({ progress: 0.01, elapsedMs: 30000 }), undefined, 'too early');
    assert.equal(at.estimateSecondsLeft({ progress: 0.5, elapsedMs: 1000 }), undefined, 'too early');
    assert.equal(at.estimateSecondsLeft({ progress: 1, elapsedMs: 30000 }), undefined, 'done');
    assert.equal(at.estimateSecondsLeft({ progress: 0.999, elapsedMs: 30000 }), 1);
});

test('file-level tags kept when merging', () => {
    const tags = {
        major_brand: 'isom', minor_version: '512', compatible_brands: 'isomiso2avc1mp41', encoder: 'Lavf62.3.100',
        title: 'My title', comment: 'a=b; c', creation_time: '2020-01-02T03:04:05.000000Z', 'com.apple.quicktime.make': 'X', empty: '',
    };
    assert.deepEqual(at.getMetadataArgs(tags), ['-metadata', 'title=My title', '-metadata', 'comment=a=b; c',
        '-metadata', 'creation_time=2020-01-02T03:04:05.000000Z', '-metadata', 'com.apple.quicktime.make=X']);
    assert.deepEqual(at.getMetadataArgs(undefined), []);
    const merge = (opts) => at.getMergeArgs({ output: 'o.mp4', streams, outFormat: 'mp4', tags, ...opts });
    assert.ok(includesInOrder(merge({}), '-metadata', 'title=My title'));
    assert.ok(includesInOrder(merge({}), '-movflags', '+faststart'));
    assert.ok(!merge({ preserveMetadata: 'nonglobal' }).includes('title=My title'), 'nonglobal: no file-level tags');
    assert.ok(includesInOrder(merge({ preserveMetadata: 'none' }), '-map_metadata', '-1'), 'none');
    assert.ok(!merge({ preserveMetadata: 'none' }).includes('title=My title'));
    assert.ok(includesInOrder(merge({ preserveMovData: true }), '-movflags', '+use_metadata_tags+faststart'));
    const cut = (opts) => at.getCutArgs({ input: 'i.mp4', output: 'o.mp4', start: 2, end: 5, duration: 20, streams, outFormat: 'mp4', ...opts });
    assert.ok(includesInOrder(cut({}), '-map_metadata', '0'));
    assert.ok(includesInOrder(cut({ preserveMetadata: 'none' }), '-map_metadata', '-1'));
    assert.ok(includesInOrder(cut({ preserveMetadata: 'nonglobal' }), '-map_metadata:g', '-1'));
    assert.ok(includesInOrder(cut({ preserveMovData: true }), '-movflags', '+use_metadata_tags+faststart'));
});

test('status page and API on the socket', async () => {
    const os = require('node:os');
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrim-test-'));
    const socket = path.join(dir, 'at.sock');
    const daemon = spawn(process.execPath, [path.join(root, 'rootfs/opt/losslesscut-tools/autotrim.cjs')], {
        env: { ...process.env, AUTOTRIM_SOCKET: socket, AUTOTRIM_STATE_FILE: path.join(dir, 'state.json'), LOSSLESSCUT_FILENAME_SEGMENTS_PATHS: dir },
        stdio: 'ignore',
    });
    const get = (urlPath) => new Promise((resolve, reject) => {
        http.get({ socketPath: socket, path: urlPath }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
        }).on('error', reject);
    });
    try {
        for (let i = 0; i < 50 && !fs.existsSync(socket); i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => { setTimeout(r, 100); });
        }
        const pageRes = await get('/');
        assert.equal(pageRes.status, 200);
        assert.match(pageRes.type, /^text\/html/);
        assert.match(pageRes.body, /data-autotrim-page/);
        assert.match(pageRes.body, /\.\.\/app\/autotrim\.js/);
        const statusRes = JSON.parse((await get('/status')).body);
        assert.equal(statusRes.enabled, false, 'off by default');
        assert.deepEqual([statusRes.queue, statusRes.pending, statusRes.waiting], [[], [], []]);
    } finally {
        daemon.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('video renaming: new names', async () => {
    const cases = [
        ['new video.mp4', '[0-1]', 'new video[0-1].mp4'],
        // An existing segments block is replaced, other brackets are kept
        ['[5-6]clip.mp4', '[0-1]', 'clip[0-1].mp4'],
        ['[5-6] clip.mp4', '[0-1]', 'clip[0-1].mp4'],
        ['clip [5-6].mp4', '[0-1]', 'clip[0-1].mp4'],
        ['[1-2]clip[3-4].MP4', '[0-1]', 'clip[0-1].MP4'],
        ['[0-968.968000,2080.078000-end]new video.mp4', '[1-2]', 'new video[1-2].mp4'],
        ['[draft]clip.mp4', '[0-1]', '[draft]clip[0-1].mp4'],
        ['my [draft] clip[5-6].mp4', '[0-1]', 'my [draft] clip[0-1].mp4'],
        ['a.b.mkv', '[0-1]', 'a.b[0-1].mkv'],
        ['[1-2].mp4', '[0-1]', '[0-1].mp4'],
    ];
    for (const [name, block, expected] of cases) {
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await at.nameWithSegments(name, block), expected, name);
    }
});

test('video renaming: API on the socket', async () => {
    const os = require('node:os');
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrim-test-'));
    const medias = path.join(dir, 'medias');
    const outside = path.join(dir, 'outside');
    const socket = path.join(dir, 'at.sock');
    const add = (rel, ageSeconds) => {
        const file = path.join(medias, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, rel);
        const time = new Date(Date.now() - ageSeconds * 1000);
        fs.utimesSync(file, time, time);
    };
    add('new video.mp4', 10);
    add('Holiday 2024.MKV', 20);
    add('[5-6]clip.mp4', 30);
    add('taken.mp4', 40);
    add('taken[0-1].mp4', 50);
    // Listed with subfolders=1
    add('sub/in a subfolder.mp4', 5);
    add('sub/Holiday notes.mp4', 25);
    // Never listed
    add('sub/holiday notes.txt', 0);
    add('.hidden/secret.mp4', 0);
    add('@Recycle/old.mp4', 0);
    add('sub/.autotrim-1-out.mp4', 0);
    add('.autotrim-2-out.mp4', 0);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.mp4'), 'x');
    fs.symlinkSync(path.join(outside, 'x.mp4'), path.join(medias, 'link.mp4'));
    fs.symlinkSync(outside, path.join(medias, 'linked folder'));
    const recent = Array.from({ length: 12 }, (_, i) => ({
        file: `/medias/v${i}.mp4`, output: `/medias/V${i}-trimmed.mp4`, ok: true, at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ enabled: false, done: {}, failed: {}, recent }));
    const daemon = spawn(process.execPath, [path.join(root, 'rootfs/opt/losslesscut-tools/autotrim.cjs')], {
        env: {
            ...process.env,
            AUTOTRIM_SOCKET: socket,
            AUTOTRIM_STATE_FILE: path.join(dir, 'state.json'),
            AUTOTRIM_RENAME_FOLDER: medias,
            LOSSLESSCUT_FILENAME_SEGMENTS_PATHS: medias,
        },
        stdio: 'ignore',
    });
    const request = (method, urlPath, body, type = 'application/json') => new Promise((resolve, reject) => {
        const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({ socketPath: socket, path: urlPath, method, headers: { 'Content-Type': type } }, (res) => {
            let text = '';
            res.on('data', (d) => { text += d; });
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null') }));
        });
        req.on('error', reject);
        req.end(data);
    });
    const names = (res) => res.json.videos.map((v) => path.join(v.dir, v.name));
    try {
        for (let i = 0; i < 50 && !fs.existsSync(socket); i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => { setTimeout(r, 100); });
        }
        // The top folder: newest first, without hidden, temp and other files,
        //  nor symbolic links
        let res = await request('GET', '/videos');
        assert.deepEqual([res.json.exists, res.json.subfolders, res.json.total], [true, false, 5]);
        assert.deepEqual(names(res), ['new video.mp4', 'Holiday 2024.MKV', '[5-6]clip.mp4', 'taken.mp4', 'taken[0-1].mp4']);
        // With its subfolders
        res = await request('GET', '/videos?subfolders=1');
        assert.deepEqual([res.json.subfolders, res.json.total], [true, 7]);
        assert.deepEqual(names(res), ['sub/in a subfolder.mp4', 'new video.mp4', 'Holiday 2024.MKV', 'sub/Holiday notes.mp4',
            '[5-6]clip.mp4', 'taken.mp4', 'taken[0-1].mp4']);
        // Every word, anywhere in the path, in any case
        res = await request('GET', `/videos?subfolders=1&q=${encodeURIComponent(' HOLIDAY  sub ')}`);
        assert.deepEqual(names(res), ['sub/Holiday notes.mp4']);
        assert.deepEqual(names(await request('GET', '/videos?q=holiday')), ['Holiday 2024.MKV']);

        // Dry run: the new name, nothing renamed
        const video = path.join(medias, 'new video.mp4');
        res = await request('POST', '/rename', { file: video, block: '[0-968.968,2080-end]', dryRun: true });
        assert.deepEqual([res.status, res.json.name, res.json.renamed], [200, 'new video[0-968.968,2080-end].mp4', false]);
        assert.ok(fs.existsSync(video));
        res = await request('POST', '/rename', { file: video, block: ' [0-968.968,2080-end] ' });
        assert.deepEqual([res.status, res.json.renamed], [200, true]);
        assert.equal(res.json.file, path.join(medias, 'new video[0-968.968,2080-end].mp4'));
        assert.ok(!fs.existsSync(video) && fs.existsSync(res.json.file));
        // Listed under its new name right away
        assert.deepEqual(names(await request('GET', '/videos?q=new')), ['new video[0-968.968,2080-end].mp4']);
        res = await request('POST', '/rename', { file: path.join(medias, '[5-6]clip.mp4'), block: '[1-2]', dryRun: true });
        assert.equal(res.json.name, 'clip[1-2].mp4');
        // Also in a subfolder (Include subfolders)
        res = await request('POST', '/rename', { file: path.join(medias, 'sub/in a subfolder.mp4'), block: '[1-2]', dryRun: true });
        assert.deepEqual([res.status, res.json.name], [200, 'in a subfolder[1-2].mp4']);

        // Never over another file
        res = await request('POST', '/rename', { file: path.join(medias, 'taken.mp4'), block: '[0-1]' });
        assert.equal(res.status, 409, JSON.stringify(res.json));
        assert.match(res.json.error, /already a file named "taken\[0-1\]\.mp4"/);
        // Refused
        for (const [file, block] of [
            ['/etc/passwd', '[0-1]'],
            [path.join(outside, 'x.mp4'), '[0-1]'],
            [`${medias}/../outside/x.mp4`, '[0-1]'],
            [path.join(medias, 'link.mp4'), '[0-1]'],
            [path.join(medias, 'linked folder', 'x.mp4'), '[0-1]'],
            [path.join(medias, '.hidden/secret.mp4'), '[0-1]'],
            [path.join(medias, 'sub/holiday notes.txt'), '[0-1]'],
            [path.join(medias, 'missing.mp4'), '[0-1]'],
            [42, '[0-1]'],
            [path.join(medias, 'taken.mp4'), '[5-2]'],
            [path.join(medias, 'taken.mp4'), '[0-1]x'],
            [path.join(medias, 'taken.mp4'), '[0-1/2]'],
            [path.join(medias, 'taken.mp4'), '[1-2\n]'],
            [path.join(medias, 'taken.mp4'), '[1-2\t,3-4\r]'],
            [path.join(medias, 'taken.mp4'), undefined],
            [path.join(medias, 'taken[0-1].mp4'), '[0-1]'],
        ]) {
            // eslint-disable-next-line no-await-in-loop
            res = await request('POST', '/rename', { file, block });
            assert.equal(res.status, 400, `${file} ${block}: ${JSON.stringify(res.json)}`);
        }
        assert.ok(fs.existsSync(path.join(outside, 'x.mp4')) && fs.lstatSync(path.join(medias, 'link.mp4')).isSymbolicLink());
        assert.equal((await request('POST', '/rename', 'file=x', 'application/x-www-form-urlencoded')).status, 415);

        // The last 5 results, or all of them
        assert.equal((await request('GET', '/status')).json.recent.length, 5);
        assert.equal((await request('GET', '/status?recent=all')).json.recent.length, 12);
        // No rename folder
        fs.renameSync(medias, `${medias}-gone`);
        res = await request('GET', '/videos');
        assert.deepEqual([res.json.exists, res.json.total], [false, 0]);
    } finally {
        daemon.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('short error messages', () => {
    assert.equal(at.cleanError('[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5610169aa0c0] moov atom not found /medias/a b/[0-3]x.mp4: Invalid data', '/medias/a b/[0-3]x.mp4'),
        'moov atom not found [0-3]x.mp4: Invalid data');
});

test('same video extensions as filename-segments', () => {
    const script = fs.readFileSync(path.join(root, 'rootfs/opt/losslesscut-tools/filename-segments'), 'utf8');
    const list = /^EXTENSIONS="([^"]+)"/m.exec(script)[1].split(' ').map((e) => `.${e}`);
    assert.deepEqual([...at.VIDEO_EXTENSIONS].sort(), list.sort());
});

test('side panel script', () => {
    const js = fs.readFileSync(path.join(root, 'rootfs/opt/noVNC/app/autotrim.js'), 'utf8');
    // Relative URLs: work behind a reverse proxy with a sub-path
    assert.match(js, /const API = isPage \? '' : 'autotrim\/';/);
    assert.doesNotMatch(js, /fetch\(['`]\//, 'no absolute URL');
    // File names are never inserted as HTML
    assert.doesNotMatch(js.replace(/section\.innerHTML = `[^`]*`;/, ''), /innerHTML/);
});

// Scratch pad of the status page (app/autotrim.js)
const page = require(path.join(root, 'rootfs/opt/noVNC/app/autotrim.js'));

test('scratch pad: same segments as filename-segments', () => {
    const tool = path.join(root, 'rootfs/opt/losslesscut-tools/filename-segments');
    const names = [
        // The names of test-scripts.sh
        'New Video[6604.630613-9797.852513].mp4', 'New Video[1.5-4,8.25-12].mp4', 'clip[0-120].mkv',
        'clip[0-end].mkv', 'clip[6196-END].MP4', 'clip[ 10 - 20 , 30-end ].mp4', 'clip[30-end].mp4',
        'clip[0006604.630-0009797.85].mp4', 'clip[0.5-1].mp4', 'my [draft] clip[5-6].mp4',
        '[0-968.968000,2080.078000-4197.393200,4682.678000-end]new video.mp4', '[5-6]my [draft] clip.mp4',
        '[5-6] clip.mp4', '[draft]clip[5-6].mp4', '[1-2]clip[3-4].mp4', '[1-2].mp4', '[1.5-2]clip', 'clip[1.5-2]',
        '[2-1]clip.mp4', 'clip [1-2] copy.mp4', 'Holiday[draft].mp4', 'clip[20-10].mp4', 'clip[10-10].mp4',
        'clip[1-2,].mp4', 'clip[1-2,3].mp4', 'clip[].mp4', 'clip[-5].mp4', 'clip[1,5-2].mp4', 'clip[1:00-2:00].mp4',
        '[0-003747.014316-end]sone-521-4k.mp4', 'clip[1-2] copy.mp4', 'clip.mp4',
        // What the scratch pad holds
        '[968.968000-1000.5]', '[ 1 - 2 ]', '[1-2] ', '[0-003747.014316-end]', '[1-2,]', '[]', '[ ]', '',
        '[0-968.968000,2080.078000-4197.393200,4682.678000-end]', '[\t1-2\t]', '[1-2]]', '[[1-2]', '[1-2', '1-2]',
        '[1 -2,3- end]', '[01-2]', '[1.-2]', '[.5-2]', '[1-2.5.5]', '[END-5]', '[1-2]new video', 'new video[1-2]',
        '[1-2]x.mp4', '[1-2.5]', '[2-1.5,3-4]', '[1-2,,3-4]', '[1-2],[3-4]', '[1 - 2 - 3]', '[5-end]', '[5-End ]',
    ];
    for (const name of names) {
        let expected;
        try {
            expected = JSON.parse(execFileSync('sh', [tool, 'parse', name], { encoding: 'utf8' }));
        } catch {
            expected = undefined;
        }
        const got = page.parseNameSegments(name);
        if (expected === undefined) {
            assert.ok(got.error, `${JSON.stringify(name)}: should be wrong, got ${JSON.stringify(got)}`);
        } else {
            assert.deepEqual(got, { segments: expected.map(({ start, end }) => ({ start, end })) }, JSON.stringify(name));
        }
    }
});

test('scratch pad: what is wrong', () => {
    const error = (text) => page.parseNameSegments(text).error;
    assert.equal(error('[2080-1000]'), 'Part 1 "2080-1000": the end must be after the start');
    assert.equal(error('[0-1,5-5]'), 'Part 2 "5-5": the end must be after the start');
    assert.equal(error('[0-003747.014316-end]'), 'Part 1 "0-003747.014316-end": write start-end in seconds, e.g. 10-20 or 30-end');
    assert.equal(error('[1:00-2:00]'), 'Part 1 "1:00-2:00": times must be in seconds (e.g. 3725.5), not h:mm:ss');
    assert.equal(error('[1-2,]'), 'Part 2 is empty (extra comma?)');
    assert.equal(error('[ ]'), 'Nothing in the brackets');
    assert.equal(error('new video'), 'No [...] at the start or the end');
    // The block at the start is the one meant
    assert.equal(error('[5-2]clip[x]'), 'Part 1 "5-2": the end must be after the start');
});

test('scratch pad: pasted line breaks removed', () => {
    assert.equal(page.cleanPastedText('968.968000 \r\n'), '968.968000');
    assert.equal(page.cleanPastedText('\n12\n'), '12');
    assert.equal(page.cleanPastedText('a\r\nb'), 'a b');
    assert.equal(page.cleanPastedText(' 1 \r 2 \n\n 3 '), '1 2 3');
    assert.equal(page.cleanPastedText('\r\n'), '');
    // Without line breaks: as is
    assert.equal(page.cleanPastedText(' new video '), ' new video ');
});

test('scratch pad: times shown as h:mm:ss', () => {
    assert.equal(page.formatTime(0), '0:00');
    assert.equal(page.formatTime(968.968), '16:08.968');
    assert.equal(page.formatTime(4197.3932), '1:09:57.393');
    assert.equal(page.formatTime(61.5), '1:01.500');
    assert.equal(page.formatTime(59.9996), '1:00');
    assert.equal(page.formatTime(3600), '1:00:00');
});

(async () => {
    let failures = 0;
    for (const [name, fn] of tests) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await fn();
            console.log(`  ok    ${name}`);
        } catch (err) {
            failures += 1;
            console.log(`  FAIL  ${name}: ${err.message}`);
        }
    }
    process.exit(failures > 0 ? 1 : 0);
})();
