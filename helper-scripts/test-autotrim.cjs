// Tests of rootfs/opt/losslesscut-tools/autotrim.cjs (background trimming):
//  the parts without side effects. Run with node, see test-scripts.sh

'use strict';

const assert = require('node:assert/strict');
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
    // Relative URL: works behind a reverse proxy with a sub-path
    assert.match(js, /const API = 'autotrim\/';/);
    // File names are never inserted as HTML
    assert.doesNotMatch(js.replace(/section\.innerHTML = `[^`]*`;/, ''), /innerHTML/);
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
