// Auto-trim: trims videos with segments in their name in the background,
// without LosslessCut's window.
//
// Usage (LosslessCut's Electron as Node.js):
//   ELECTRON_RUN_AS_NODE=1 /LosslessCut/losslesscut autotrim.cjs
//
// - Off until switched on in the side panel of the web page; the choice is kept
//   in /config/autotrim/state.json
// - When on, the mapped folders (see filename-segments) are scanned every
//   LOSSLESSCUT_AUTOTRIM_INTERVAL seconds for videos named e.g.
//   "[10-20,30-end]New Video.mp4". A video is queued once it hasn't changed
//   for AUTOTRIM_SETTLE seconds (copy finished), and the queue is trimmed one
//   video at a time, oldest first
// - The segments come from the video's project file if there's one (it has
//   your changes if you edited them in LosslessCut), else from the name
// - A video opened or edited in LosslessCut waits until LosslessCut hasn't
//   saved its project for AUTOTRIM_EDIT_QUIET seconds (10 minutes): LosslessCut
//   saves the project file when it opens a video and after each change
// - The trim is the same as LosslessCut's export with keyframe cut: each
//   segment is copied with ffmpeg, then the parts are merged
// - The output name and the cleanup (source and project file moved to the
//   trash) follow LosslessCut's settings, an existing file is never
//   overwritten: " (2)" is added to the name
// - The output keeps the source's modified time, permissions and tags (also
//   when segments are merged), within LosslessCut's metadata settings
// - HTTP API on a unix socket, reached through nginx at /autotrim/:
//   GET /status, POST /enabled {"enabled": true|false}, POST /scan,
//   POST /retry (failed videos are tried again), and GET / for the status page

'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const env = process.env;

function seconds(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const config = {
    socket: env.AUTOTRIM_SOCKET || '/tmp/autotrim.sock',
    stateFile: env.AUTOTRIM_STATE_FILE || '/config/autotrim/state.json',
    losslessCutConfig: env.AUTOTRIM_LOSSLESSCUT_CONFIG
        || path.join(env.XDG_CONFIG_HOME || '/config/xdg/config', 'LosslessCut', 'config.json'),
    ffmpeg: env.LOSSLESSCUT_FFMPEG || '/LosslessCut/resources/ffmpeg',
    ffprobe: env.LOSSLESSCUT_FFPROBE || '/LosslessCut/resources/ffprobe',
    segmentsTool: env.AUTOTRIM_SEGMENTS_TOOL || path.join(__dirname, 'filename-segments'),
    folders: env.LOSSLESSCUT_FILENAME_SEGMENTS_PATHS || 'auto',
    intervalMs: seconds(env.LOSSLESSCUT_AUTOTRIM_INTERVAL, 60) * 1000,
    settleMs: seconds(env.AUTOTRIM_SETTLE, 30) * 1000,
    editQuietMs: seconds(env.AUTOTRIM_EDIT_QUIET, 600) * 1000,
    notifySend: env.AUTOTRIM_NOTIFY_SEND || '/opt/base/bin/notify-send',
    gio: env.AUTOTRIM_GIO || 'gio',
    ionice: env.AUTOTRIM_IONICE || '/usr/bin/ionice',
    page: env.AUTOTRIM_PAGE || path.join(__dirname, 'autotrim-page.html'),
};

// Same list as filename-segments
const VIDEO_EXTENSIONS = new Set('mp4 m4v mov mkv webm avi ts m2ts mts mpg mpeg vob flv wmv 3gp mxf ogv mp3 m4a aac flac wav ogg opus mka'
    .split(' ').map((ext) => `.${ext}`));
const TEMP_PREFIX = '.autotrim-';
// In the project files created by filename-segments (LosslessCut's don't have it)
const GENERATED_MARKER = '"generatedBy": "docker-losslesscut filename-segments"';
const RECENT_MAX = 20;

// LosslessCut's defaults (used when its settings don't have a template)
const DEFAULT_CUT_TEMPLATE = '${FILENAME}-${CUT_FROM}-${CUT_TO}${SEG_SUFFIX}${EXT}';
const DEFAULT_CUT_MERGED_TEMPLATE = '${FILENAME}-cut-merged-${EPOCH_MS}${EXT}';
const DEFAULT_CLEANUP = { trashTmpFiles: true, askForCleanup: true, closeFile: true, cleanupAfterExport: false };

const log = (...args) => console.log(new Date().toTimeString().slice(0, 8), ...args);

//
// Helpers without side effects (exported for tests)
//

// Minimal JSON5 parser: LosslessCut writes its project files with JSON5
//  (unquoted keys, single quotes)
function parseJson5(text) {
    let i = 0;
    const fail = (msg) => { throw new SyntaxError(`${msg} at position ${i}`); };
    const skip = () => {
        for (;;) {
            const c = text[i];
            if (c === undefined) return;
            if (/\s/.test(c) || c === '﻿') { i += 1; continue; }
            if (c === '/' && text[i + 1] === '/') {
                const end = text.indexOf('\n', i);
                i = end < 0 ? text.length : end;
                continue;
            }
            if (c === '/' && text[i + 1] === '*') {
                const end = text.indexOf('*/', i + 2);
                if (end < 0) fail('unterminated comment');
                i = end + 2;
                continue;
            }
            return;
        }
    };
    const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };
    const string = () => {
        const quote = text[i];
        i += 1;
        let s = '';
        for (;;) {
            const c = text[i];
            i += 1;
            if (c === undefined) fail('unterminated string');
            if (c === quote) return s;
            if (c !== '\\') { s += c; continue; }
            const e = text[i];
            i += 1;
            if (e === 'u' || e === 'x') {
                const len = e === 'u' ? 4 : 2;
                const hex = text.slice(i, i + len);
                if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail('bad escape');
                s += String.fromCharCode(parseInt(hex, 16));
                i += len;
            } else if (e === '\r') {
                if (text[i] === '\n') i += 1;
            } else if (e !== '\n' && e !== ' ' && e !== ' ') {
                s += escapes[e] ?? e;
            }
        }
    };
    const identifier = () => {
        const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 256));
        if (!m) fail('unexpected character');
        i += m[0].length;
        return m[0];
    };
    const set = (obj, key, val) => {
        if (key !== '__proto__') obj[key] = val;
    };
    const value = () => {
        skip();
        const c = text[i];
        if (c === '{') {
            i += 1;
            const obj = {};
            for (;;) {
                skip();
                if (text[i] === '}') { i += 1; return obj; }
                const key = text[i] === '"' || text[i] === "'" ? string() : identifier();
                skip();
                if (text[i] !== ':') fail('expected ":"');
                i += 1;
                set(obj, key, value());
                skip();
                if (text[i] === ',') { i += 1; continue; }
                if (text[i] === '}') { i += 1; return obj; }
                fail('expected "," or "}"');
            }
        }
        if (c === '[') {
            i += 1;
            const arr = [];
            for (;;) {
                skip();
                if (text[i] === ']') { i += 1; return arr; }
                arr.push(value());
                skip();
                if (text[i] === ',') { i += 1; continue; }
                if (text[i] === ']') { i += 1; return arr; }
                fail('expected "," or "]"');
            }
        }
        if (c === '"' || c === "'") return string();
        const m = /^([+-]?)(Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
        if (m) {
            i += m[0].length;
            const n = Number(m[2]);
            return m[1] === '-' ? -n : n;
        }
        const word = identifier();
        if (word === 'true') return true;
        if (word === 'false') return false;
        if (word === 'null') return null;
        return fail(`unexpected "${word}"`);
    };
    const result = value();
    skip();
    if (i < text.length) fail('unexpected content');
    return result;
}

const isVideoFile = (file) => VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase());

// Hidden files/folders, QNAP's @Recycle, .@__thumb, ...
const isExcludedName = (name) => name.startsWith('.') || name.startsWith('@');

const statKey = (st) => ({ size: st.size, mtimeMs: Math.round(st.mtimeMs) });
const sameStat = (a, b) => a != null && b != null && a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);

// Ready to be queued: unchanged since the previous scan and not modified for
//  settleMs (copies are done)
function isSettled({ previous, current, now, settleMs }) {
    return sameStat(previous, current) && now - current.mtimeMs >= settleMs;
}

// Seconds left for the current trim, from its progress so far. Undefined until
//  there's enough to go by
function estimateSecondsLeft({ progress, elapsedMs }) {
    if (!(progress >= 0.02 && progress < 1) || !(elapsedMs >= 3000)) return undefined;
    return Math.max(1, Math.round((elapsedMs / 1000) * ((1 - progress) / progress)));
}

// Is the video being worked on in LosslessCut? Its project file was saved by
//  LosslessCut (not generated) less than quietMs ago
function isBeingEdited({ projectText, projectMtimeMs, now, quietMs }) {
    return projectText != null && !projectText.includes(GENERATED_MARKER) && now - projectMtimeMs < quietMs;
}

// Output format, like LosslessCut: from ffprobe's format name, the extension
//  deciding between the formats sharing a demuxer
function getOutFormat({ formatName, ext, streams }) {
    const formats = String(formatName || '').split(',').map((f) => f.trim()).filter(Boolean);
    let format = formats[0];
    if (format == null) return undefined;
    if (formats.length > 1) {
        const e = ext.toLowerCase();
        if (format === 'matroska') {
            format = e === '.webm' ? 'webm' : 'matroska';
        } else if (format === 'mov') {
            format = { '.mp4': 'mp4', '.m4v': 'mp4', '.m4a': 'ipod', '.3gp': '3gp', '.3g2': '3g2' }[e] ?? 'mov';
        }
    }
    if (format === 'aac') format = 'adts';
    // FFmpeg can't put PCM audio in MP4
    if (format === 'mp4' && streams.some((s) => String(s.codec_name).startsWith('pcm_'))) format = 'mov';
    return format;
}

const isMov = (format) => ['mov', 'mp4', 'ipod', '3gp', '3g2', 'ismv'].includes(format);

// Streams LosslessCut copies by default
function shouldCopyStream(stream) {
    switch (stream.codec_type) {
        case 'audio':
        case 'attachment':
        case 'video':
            return true;
        case 'subtitle':
            return stream.codec_name !== 'dvb_teletext';
        case 'data':
            return stream.codec_name === 'bin_data' && stream.codec_tag_string === 'gpmd';
        default:
            return false;
    }
}

// Per stream codec arguments, like LosslessCut's getPerStreamFlags
function getStreamCodecArgs({ stream, outputIndex, outFormat, needFlac }) {
    const codec = (c) => [`-c:${outputIndex}`, c];
    if (stream.codec_type === 'subtitle') {
        if (isMov(outFormat) && !['dvb_subtitle', 'mov_text'].includes(stream.codec_name)) return codec('mov_text');
        if (outFormat === 'matroska' && stream.codec_name === 'mov_text') return codec('srt');
        if (outFormat === 'webm' && stream.codec_name !== 'webvtt') return codec('webvtt');
        return codec('copy');
    }
    if (stream.codec_type === 'audio') {
        if (stream.codec_name === 'pcm_bluray' && outFormat !== 'mpegts') return codec('pcm_s24le');
        if (stream.codec_name === 'pcm_dvd' && ['matroska', 'mov'].includes(outFormat)) return codec('pcm_s32le');
        if (outFormat === 'flac' && needFlac && stream.codec_name === 'flac') return codec('flac');
    }
    return codec('copy');
}

const formatNumber = (n) => String(Number(n.toFixed(6)));

// Tags written by the muxer itself
const MUXER_TAGS = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder']);

// -metadata arguments for the source's file-level tags (title, creation_time,
//  comment, ...). Used when merging: the concat demuxer doesn't pass them on
function getMetadataArgs(tags) {
    return Object.entries(tags || {})
        .filter(([key, value]) => !MUXER_TAGS.has(key.toLowerCase()) && value != null && String(value) !== '')
        .flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
}

// LosslessCut's "preserveMetadata" setting: default, none, nonglobal
function getPreserveMetadataArgs(preserveMetadata) {
    if (preserveMetadata === 'none') return ['-map_metadata', '-1'];
    if (preserveMetadata === 'nonglobal') return ['-map_metadata:g', '-1'];
    return ['-map_metadata', '0'];
}

// LosslessCut's "preserveMovData" setting: all MP4/MOV tags
const getMovFlags = (preserveMovData) => ['-movflags', preserveMovData ? '+use_metadata_tags+faststart' : '+faststart'];

// ffmpeg arguments to copy one segment, like LosslessCut's lossless cut with
//  "keyframe cut" (seeking before the input, -avoid_negative_ts make_zero)
function getCutArgs({ input, output, start, end, duration, streams, outFormat, preserveMetadata = 'default', preserveMovData = false }) {
    const cuttingStart = start > 0;
    const cuttingEnd = !(duration > 0) || end < duration;
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
    if (cuttingStart) args.push('-ss', formatNumber(start));
    args.push('-i', input);
    if (cuttingEnd) args.push('-t', formatNumber(end - start));
    if (cuttingStart) args.push('-avoid_negative_ts', 'make_zero');
    streams.filter(shouldCopyStream).forEach((stream, outputIndex) => {
        args.push('-map', `0:${stream.index}`,
            ...getStreamCodecArgs({ stream, outputIndex, outFormat, needFlac: cuttingStart || cuttingEnd }));
    });
    args.push(...getPreserveMetadataArgs(preserveMetadata), ...getMovFlags(preserveMovData),
        '-default_mode', 'infer_no_subs', '-ignore_unknown', '-f', outFormat, '-y', output);
    return args;
}

// The first disposition set, copied by hand when merging (like LosslessCut)
function getActiveDisposition(disposition) {
    if (disposition == null) return undefined;
    return Object.keys(disposition).find((key) => disposition[key] === 1);
}

// ffmpeg arguments to merge the parts (concat demuxer, list on stdin), with
//  the source's file-level tags (tags)
function getMergeArgs({ output, streams, outFormat, tags, preserveMetadata = 'default', preserveMovData = false }) {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
        '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe,fd', '-i', '-'];
    streams.filter(shouldCopyStream).forEach((stream, outputIndex) => {
        args.push('-map', `0:${outputIndex}`, `-c:${outputIndex}`, 'copy');
        const disposition = getActiveDisposition(stream.disposition);
        if (disposition != null) args.push(`-disposition:${outputIndex}`, disposition);
    });
    if (preserveMetadata === 'none') args.push('-map_metadata', '-1');
    else if (preserveMetadata !== 'nonglobal') args.push(...getMetadataArgs(tags));
    args.push(...getMovFlags(preserveMovData), '-default_mode', 'infer_no_subs', '-ignore_unknown',
        '-f', outFormat, '-y', output);
    return args;
}

const getConcatList = (files) => files
    .map((file) => `file 'file:${path.resolve(file).replaceAll("'", String.raw`'\''`)}'`).join('\n');

// LosslessCut's file name friendly timecode: hh.mm.ss.mmm
function formatTimecode(sec) {
    const ms = Math.round(sec * 1000);
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(Math.floor(ms / 3600000))}.${pad(Math.floor(ms / 60000) % 60)}.${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

// Output file name from a LosslessCut template (a JavaScript template string)
function interpolateTemplate(template, { file, ext, segments, epochMs }) {
    const { name } = path.parse(file);
    const single = segments.length === 1 ? segments[0] : undefined;
    const context = {
        FILENAME: name,
        EXT: ext,
        SEG_SUFFIX: '',
        SEG_NUM: '1',
        SEG_NUM_INT: 1,
        SELECTED_SEG_NUM: '1',
        SELECTED_SEG_NUM_INT: 1,
        SEG_LABEL: segments.length === 1 ? '' : segments.map(() => ''),
        SEG_TAGS: {},
        EPOCH_MS: epochMs,
        CUT_FROM: single && formatTimecode(single.start),
        CUT_FROM_NUM: single?.start,
        CUT_TO: single && formatTimecode(single.end),
        CUT_TO_NUM: single?.end,
        CUT_DURATION: single && formatTimecode(single.end - single.start),
        FILES: [{ path: file, name: path.basename(file) }],
        EXPORT_COUNT: 1,
        FILE_EXPORT_COUNT: 1,
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function(...Object.keys(context), `return \`${template}\`;`);
    const result = fn(...Object.values(context));
    if (typeof result !== 'string') throw new Error('template did not lead to a string');
    return result;
}

// Output file name: LosslessCut's template (cut + merge for several segments),
//  falling back to LosslessCut's default template if it's invalid
function getOutputName({ losslessCutConfig, file, ext, segments, epochMs }) {
    const merged = segments.length > 1;
    const template = (merged ? losslessCutConfig.mergedFileTemplate : losslessCutConfig.outSegTemplate)
        || (merged ? DEFAULT_CUT_MERGED_TEMPLATE : DEFAULT_CUT_TEMPLATE);
    const fallback = merged ? DEFAULT_CUT_MERGED_TEMPLATE : DEFAULT_CUT_TEMPLATE;
    const valid = (name) => name && !/[/\\]/.test(name) && name !== '.' && name !== '..'
        && name !== path.basename(file);
    for (const t of [template, fallback]) {
        try {
            const name = interpolateTemplate(t, { file, ext, segments, epochMs }).trim();
            if (valid(name)) return name;
        } catch {
            // next template
        }
    }
    throw new Error('Could not make an output file name from the template');
}

// Segments to keep: selected segments with an end (the others are markers),
//  clamped to the duration
function normalizeSegments(segments, duration) {
    return segments
        .filter((s) => s && s.selected !== false)
        .map((s) => ({ start: Number(s.start ?? 0), end: s.end == null ? undefined : Number(s.end) }))
        .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
        .map((s) => ({ start: Math.max(0, s.start), end: duration > 0 ? Math.min(s.end, duration) : s.end }))
        .filter((s) => s.end > s.start);
}

// What to do with the source and project file after a trim, from LosslessCut's
//  cleanup settings. Nothing unless the cleanup is automatic (not asked)
function getCleanup(choices) {
    const c = { ...DEFAULT_CLEANUP, ...(choices || {}) };
    const auto = c.cleanupAfterExport === true && c.askForCleanup !== true;
    return {
        trashSource: auto && c.trashSourceFile === true,
        trashProject: auto && c.trashProjectFile === true,
        deleteIfTrashFails: c.deleteIfTrashFails === true,
    };
}

// Short error message for the side panel: without FFmpeg's "[mov,mp4 @ 0x...]"
//  prefixes and the folder of the video
function cleanError(message, file) {
    return String(message)
        .split(`${path.dirname(file)}/`).join('')
        .replace(/\[[\w,]+ @ 0x[0-9a-f]+\] /g, '')
        .trim();
}

// "name (2).ext", "name (3).ext", ... until it doesn't exist
async function uniquePath(file, exists) {
    if (!await exists(file)) return file;
    const { dir, name, ext } = path.parse(file);
    for (let n = 2; ; n += 1) {
        const candidate = path.join(dir, `${name} (${n})${ext}`);
        // eslint-disable-next-line no-await-in-loop
        if (!await exists(candidate)) return candidate;
    }
}

//
// Processes
//

let currentChild;

// Run a program, resolving with its output. With onStdout, stdout is passed
//  line by line instead
function run(command, args, { input, onStdout, lowPriority = false } = {}) {
    return new Promise((resolve, reject) => {
        let cmd = command;
        let cmdArgs = args;
        if (lowPriority && fs.existsSync(config.ionice)) {
            // Idle I/O priority: the NAS's other work comes first
            cmd = config.ionice;
            cmdArgs = ['-c', '3', command, ...args];
        }
        const child = spawn(cmd, cmdArgs, {
            // FFmpeg's libraries are next to LosslessCut's ffmpeg and ffprobe
            env: { ...process.env, LD_LIBRARY_PATH: [...new Set([config.ffprobe, config.ffmpeg].map(path.dirname))].join(':') },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        currentChild = child;
        let stdout = '';
        let stderr = '';
        let partial = '';
        child.stdout.on('data', (data) => {
            if (!onStdout) { stdout += data; return; }
            const lines = (partial + data).split('\n');
            partial = lines.pop();
            lines.forEach(onStdout);
        });
        child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            if (currentChild === child) currentChild = undefined;
            if (code === 0) resolve({ stdout, stderr });
            else {
                const msg = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || `exit code ${code ?? signal}`;
                reject(Object.assign(new Error(msg), { code, signal }));
            }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input ?? '');
    });
}

async function ffprobe(file) {
    const { stdout } = await run(config.ffprobe,
        ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', '-i', file]);
    return JSON.parse(stdout);
}

// Segments in the file name (filename-segments parse), undefined if none
async function getNameSegments(file, duration) {
    try {
        const { stdout } = await run('sh', [config.segmentsTool, 'parse', path.basename(file),
            duration > 0 ? String(duration) : '']);
        return JSON.parse(stdout);
    } catch {
        return undefined;
    }
}

async function hasNameSegments(file) {
    return (await getNameSegments(file)) != null;
}

// Validity of a name doesn't change: parsed once per file
async function hasNameSegmentsCached(file) {
    if (!nameSegments.has(file)) nameSegments.set(file, await hasNameSegments(file));
    return nameSegments.get(file);
}

const projectPath = (file) => {
    const { dir, name } = path.parse(file);
    return path.join(dir, `${name}-proj.llc`);
};

// Segments of the project file next to the video, undefined if there's none
async function getProjectSegments(file) {
    let text;
    try {
        text = await fsp.readFile(projectPath(file), 'utf8');
    } catch {
        return undefined;
    }
    try {
        const project = parseJson5(text);
        return Array.isArray(project?.cutSegments) ? project.cutSegments : undefined;
    } catch (err) {
        log(`WARNING: ignoring unreadable project file ${projectPath(file)}: ${err.message}`);
        return undefined;
    }
}

// Until when to wait because the video is being worked on in LosslessCut,
//  undefined if it isn't
async function editedUntil(file) {
    const project = projectPath(file);
    const st = await fsp.stat(project).catch(() => undefined);
    if (!st) return undefined;
    const projectText = await fsp.readFile(project, 'utf8').catch(() => undefined);
    return isBeingEdited({ projectText, projectMtimeMs: st.mtimeMs, now: Date.now(), quietMs: config.editQuietMs })
        ? st.mtimeMs + config.editQuietMs : undefined;
}

async function readLosslessCutConfig() {
    try {
        return JSON.parse(await fsp.readFile(config.losslessCutConfig, 'utf8')) || {};
    } catch {
        return {};
    }
}

const exists = (file) => fsp.lstat(file).then(() => true, () => false);

async function moveToTrash(file, deleteIfTrashFails) {
    try {
        await run(config.gio, ['trash', path.resolve(file)]);
        return 'trash';
    } catch (err) {
        if (!deleteIfTrashFails) throw err;
        await fsp.unlink(file);
        return 'deleted';
    }
}

function notify(title, message) {
    if (!fs.existsSync(config.notifySend)) return;
    const child = spawn(config.notifySend, [title, message], { stdio: 'ignore' });
    child.on('error', () => {});
}

// Is the file open in another process (e.g. in LosslessCut's window)?
async function isOpenElsewhere(file) {
    const pids = await fsp.readdir('/proc').catch(() => []);
    for (const pid of pids) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        // eslint-disable-next-line no-await-in-loop
        const fds = await fsp.readdir(`/proc/${pid}/fd`).catch(() => []);
        for (const fd of fds) {
            // eslint-disable-next-line no-await-in-loop
            const target = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined);
            if (target === file) return true;
        }
    }
    return false;
}

//
// State
//

const state = {
    enabled: false,
    done: {}, // file -> { size, mtimeMs }: trimmed, or produced by a trim
    failed: {}, // file -> { size, mtimeMs, error }: not tried again unless changed
    recent: [], // { file, output, ok, error, at, seconds }
};
const seen = new Map(); // file -> { size, mtimeMs } at the previous scan
const postponed = new Map(); // file -> { until, reason }: wait until then
const settling = new Map(); // file -> { mtimeMs }: segments name, copy not finished (or just found)
const nameSegments = new Map(); // file -> whether its name has valid segments
let queue = [];
let current;
let scanning = false;
let working = false;
let cancelled = false;
let scanTimer;
let lastScan;
let folders = [];

async function loadState() {
    try {
        const saved = JSON.parse(await fsp.readFile(config.stateFile, 'utf8'));
        state.enabled = saved.enabled === true;
        state.done = saved.done || {};
        state.failed = saved.failed || {};
        state.recent = Array.isArray(saved.recent) ? saved.recent.slice(0, RECENT_MAX) : [];
    } catch {
        // First start: off
    }
}

let saving = Promise.resolve();
function saveState() {
    saving = saving.then(async () => {
        try {
            await fsp.mkdir(path.dirname(config.stateFile), { recursive: true });
            const tmp = `${config.stateFile}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
            await fsp.rename(tmp, config.stateFile);
        } catch (err) {
            log(`WARNING: could not save ${config.stateFile}: ${err.message}`);
        }
    });
    return saving;
}

function addRecent(entry) {
    state.recent = [{ ...entry, at: new Date().toISOString() }, ...state.recent].slice(0, RECENT_MAX);
}

//
// Scanning
//

async function getFolders() {
    const list = config.folders.trim();
    if (list !== 'auto') return list.split(',').map((f) => f.trim()).filter(Boolean);
    try {
        const { stdout } = await run('sh', [config.segmentsTool, 'mapped-folders']);
        const found = stdout.split('\n').filter(Boolean);
        return found.length > 0 ? found : ['/storage'];
    } catch {
        return ['/storage'];
    }
}

// Videos with brackets in their name under dir, and leftover temp files
async function walk(dir, found, leftovers) {
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.name.startsWith(TEMP_PREFIX) && entry.isFile()) {
            leftovers.push(file);
        } else if (isExcludedName(entry.name)) {
            // skipped
        } else if (entry.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop
            await walk(file, found, leftovers);
        } else if (entry.isFile() && /\[.*\]/.test(entry.name) && isVideoFile(entry.name)) {
            // eslint-disable-next-line no-await-in-loop
            const st = await fsp.stat(file).catch(() => undefined);
            if (st) found.set(file, statKey(st));
        }
    }
}

function scheduleScan(delayMs) {
    clearTimeout(scanTimer);
    if (!state.enabled) return;
    scanTimer = setTimeout(() => { scan().catch((err) => log(`scan failed: ${err.stack || err}`)); }, delayMs);
}

async function scan() {
    if (!state.enabled || scanning) return;
    scanning = true;
    let nextScanMs = config.intervalMs;
    try {
        folders = await getFolders();
        const found = new Map();
        const leftovers = [];
        for (const dir of folders) {
            // eslint-disable-next-line no-await-in-loop
            await walk(dir, found, leftovers);
        }
        lastScan = new Date().toISOString();

        // Temp files of an interrupted trim (e.g. container restarted)
        if (!working) {
            await Promise.all(leftovers.map((f) => fsp.unlink(f).then(() => log(`removed leftover ${f}`), () => {})));
        }

        // Forget the files that are gone or changed
        let changed = false;
        for (const map of [state.done, state.failed]) {
            for (const file of Object.keys(map)) {
                const st = found.get(file) ?? await fsp.stat(file).then(statKey, () => undefined);
                if (!sameStat(map[file], st)) { delete map[file]; changed = true; }
            }
        }
        if (changed) await saveState();
        for (const file of seen.keys()) if (!found.has(file)) seen.delete(file);
        for (const file of nameSegments.keys()) if (!found.has(file)) nameSegments.delete(file);
        settling.clear();
        for (const [file, { until }] of postponed) if (!found.has(file) || until <= Date.now()) postponed.delete(file);
        queue = queue.filter((file) => found.has(file));

        const now = Date.now();
        const candidates = [];
        for (const [file, st] of found) {
            if (state.done[file] || state.failed[file] || queue.includes(file) || current?.file === file
                || postponed.has(file)) continue;
            const previous = seen.get(file);
            seen.set(file, st);
            if (isSettled({ previous, current: st, now, settleMs: config.settleMs })) {
                candidates.push([file, st]);
            } else {
                // eslint-disable-next-line no-await-in-loop
                if (await hasNameSegmentsCached(file)) settling.set(file, { mtimeMs: st.mtimeMs });
                // Look again once it could be settled
                nextScanMs = Math.min(nextScanMs, Math.max(config.settleMs - (now - st.mtimeMs), 2000));
            }
        }
        // Oldest first
        candidates.sort((a, b) => a[1].mtimeMs - b[1].mtimeMs || a[0].localeCompare(b[0]));
        for (const [file] of candidates) {
            // eslint-disable-next-line no-await-in-loop
            if (await hasNameSegmentsCached(file)) {
                // eslint-disable-next-line no-await-in-loop
                const edited = await editedUntil(file);
                if (edited != null) {
                    // Listed as waiting right away (trimNext checks again)
                    log(`waiting, edited in LosslessCut: ${file}`);
                    postponed.set(file, { until: edited, reason: 'edited in LosslessCut' });
                    continue;
                }
                queue.push(file);
                log(`queued ${file}`);
            } else {
                seen.delete(file);
                // Not a segments name: remember it as done so it's not parsed again
                state.done[file] = { ...found.get(file), ignored: true };
                changed = true;
            }
        }
        if (changed) await saveState();
    } finally {
        scanning = false;
        scheduleScan(nextScanMs);
    }
    processQueue();
}

//
// Trimming
//

async function trim(file, onProgress) {
    const probe = await ffprobe(file).catch((err) => {
        throw new Error(`Can't read the video (incomplete or damaged?): ${err.message.split('\n').pop()}`);
    });
    const duration = Number(probe.format?.duration);
    const streams = probe.streams || [];
    const ext = path.extname(file);
    const outFormat = getOutFormat({ formatName: probe.format?.format_name, ext, streams });
    if (!outFormat) throw new Error('Unknown file format');
    if (!streams.some(shouldCopyStream)) throw new Error('No stream to copy');

    const projectSegments = await getProjectSegments(file);
    const segments = normalizeSegments(projectSegments ?? await getNameSegments(file, duration) ?? [], duration);
    if (segments.length === 0) throw new Error('No segment to keep');

    const losslessCutConfig = await readLosslessCutConfig();
    const metadata = {
        preserveMetadata: losslessCutConfig.preserveMetadata ?? 'default',
        preserveMovData: losslessCutConfig.preserveMovData === true,
    };
    const dir = path.dirname(file);
    const name = getOutputName({ losslessCutConfig, file, ext, segments, epochMs: Date.now() });
    const tempOutput = path.join(dir, `${TEMP_PREFIX}${process.pid}-out${ext}`);
    const parts = segments.length > 1
        ? segments.map((_, n) => path.join(dir, `${TEMP_PREFIX}${process.pid}-part${n + 1}${ext}`)) : [tempOutput];
    const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0) * (segments.length > 1 ? 2 : 1);
    let doneSeconds = 0;
    const progress = (step, base) => (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onProgress(Math.min(0.99, (base + Number(m[1]) / 1e6) / total), step);
    };

    try {
        for (const [n, segment] of segments.entries()) {
            const step = segments.length > 1 ? `Cutting ${n + 1}/${segments.length}` : 'Cutting';
            onProgress(doneSeconds / total, step);
            if (cancelled) throw new Error('cancelled');
            // eslint-disable-next-line no-await-in-loop
            await run(config.ffmpeg, getCutArgs({ input: file, output: parts[n], ...segment, duration, streams, outFormat, ...metadata }),
                { onStdout: progress(step, doneSeconds), lowPriority: true });
            doneSeconds += segment.end - segment.start;
        }
        if (segments.length > 1) {
            onProgress(doneSeconds / total, 'Merging');
            if (cancelled) throw new Error('cancelled');
            await run(config.ffmpeg, getMergeArgs({ output: tempOutput, streams, outFormat, tags: probe.format?.tags, ...metadata }),
                { input: getConcatList(parts), onStdout: progress('Merging', doneSeconds), lowPriority: true });
        }
        const st = await fsp.stat(tempOutput);
        if (st.size === 0) throw new Error('Empty output');
        // Never overwrite an existing file
        const output = await uniquePath(path.join(dir, name), exists);
        await fsp.rename(tempOutput, output);
        return { output, segments };
    } finally {
        await Promise.all([...parts, tempOutput].map((f) => fsp.unlink(f).catch(() => {})));
    }
}

// The output keeps the source's permissions and access/modified times
async function keepFileAttributes(output, source) {
    await fsp.chmod(output, source.mode & 0o7777)
        .catch((err) => log(`WARNING: could not set the permissions of ${output}: ${err.message}`));
    await fsp.utimes(output, source.atimeMs / 1000, source.mtimeMs / 1000)
        .catch((err) => log(`WARNING: could not set the times of ${output}: ${err.message}`));
}

async function cleanup(file) {
    const { cleanupChoices } = await readLosslessCutConfig();
    const { trashSource, trashProject, deleteIfTrashFails } = getCleanup(cleanupChoices);
    const project = projectPath(file);
    if (trashProject && await exists(project)) {
        await moveToTrash(project, deleteIfTrashFails).catch((err) => log(`WARNING: ${project} not moved to the trash: ${err.message}`));
    }
    if (trashSource) {
        const how = await moveToTrash(file, deleteIfTrashFails).catch((err) => {
            log(`WARNING: ${file} not moved to the trash: ${err.message}`);
            return undefined;
        });
        return how;
    }
    return 'kept';
}

async function trimNext(file) {
    const source = await fsp.stat(file).catch(() => undefined);
    if (!source) return;
    const st = statKey(source);
    const edited = await editedUntil(file);
    if (edited != null) {
        log(`waiting, edited in LosslessCut: ${file}`);
        // The regular scans queue it again once it's quiet
        postponed.set(file, { until: edited, reason: 'edited in LosslessCut' });
        return;
    }
    if (await isOpenElsewhere(file)) {
        log(`waiting, open in another program: ${file}`);
        postponed.set(file, { until: Date.now() + config.intervalMs, reason: 'open in another program' });
        return;
    }
    const started = Date.now();
    current = { file, progress: 0, step: 'Starting', startedAt: new Date(started).toISOString() };
    log(`trimming ${file}`);
    try {
        const { output, segments } = await trim(file, (progress, step) => {
            current = { ...current, progress, step };
        });
        await keepFileAttributes(output, source);
        // An output name with [..] (custom template) mustn't be trimmed again
        const outputStat = /\[.*\]/.test(path.basename(output)) && await fsp.stat(output).then(statKey, () => undefined);
        if (outputStat) state.done[output] = { ...outputStat, output: true };
        const cleaned = await cleanup(file);
        // Kept (or the trash failed): don't trim it again
        if (await exists(file)) state.done[file] = st;
        const secs = Math.round((Date.now() - started) / 1000);
        log(`done ${file} -> ${output} (${segments.length} segment(s), ${secs}s, source: ${cleaned ?? 'kept, trash failed'})`);
        addRecent({ file, output, ok: true, seconds: secs });
        notify('Trimmed in the background', path.basename(output));
    } catch (err) {
        if (cancelled) {
            log(`cancelled ${file}`);
            addRecent({ file, ok: false, error: 'Cancelled (auto-trim switched off)' });
        } else {
            const error = cleanError(err.message, file);
            log(`failed ${file}: ${error}`);
            state.failed[file] = { ...st, error };
            addRecent({ file, ok: false, error });
            notify('Background trim failed', `${path.basename(file)}: ${error}`);
        }
    } finally {
        current = undefined;
        await saveState();
    }
}

// One video at a time
async function processQueue() {
    if (working) return;
    working = true;
    try {
        while (state.enabled && queue.length > 0) {
            cancelled = false;
            // eslint-disable-next-line no-await-in-loop
            await trimNext(queue.shift());
        }
    } finally {
        working = false;
    }
}

async function setEnabled(enabled) {
    if (state.enabled === enabled) return;
    state.enabled = enabled;
    log(enabled ? 'switched on' : 'switched off');
    if (enabled) {
        scheduleScan(0);
    } else {
        clearTimeout(scanTimer);
        queue = [];
        seen.clear();
        postponed.clear();
        settling.clear();
        if (current) {
            cancelled = true;
            currentChild?.kill('SIGTERM');
        }
    }
    await saveState();
}

//
// HTTP API
//

function status() {
    const failed = Object.entries(state.failed).map(([file, f]) => ({ file, error: f.error }));
    return {
        enabled: state.enabled,
        folders,
        intervalSeconds: config.intervalMs / 1000,
        lastScan,
        current: current && {
            ...current,
            name: path.basename(current.file),
            secondsLeft: estimateSecondsLeft({ progress: current.progress, elapsedMs: Date.now() - Date.parse(current.startedAt) }),
        },
        queue: queue.map((file) => ({ file, name: path.basename(file) })),
        // Being copied (or just found): queued once they haven't changed for a while
        pending: [...settling].map(([file, { mtimeMs }]) => ({
            file, name: path.basename(file), reason: Date.now() - mtimeMs < config.settleMs ? 'copying' : 'checking',
        })),
        waiting: [...postponed].map(([file, { until, reason }]) => ({
            file, name: path.basename(file), reason, until: new Date(until).toISOString(),
        })),
        recent: state.recent.map((r) => ({ ...r, name: path.basename(r.file), outputName: r.output && path.basename(r.output) })),
        failed,
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (data) => {
            body += data;
            if (body.length > 10000) reject(new Error('too large'));
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function handle(req, res) {
    const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    const route = `${req.method} ${new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '')}`;
    if (route === 'GET /status') return send(200, status());
    if (route === 'GET ') {
        // Status page (nginx: /autotrim/)
        const html = await fsp.readFile(config.page);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(html);
    }
    if (req.method === 'POST') {
        // JSON only: a page from another site can't send it without CORS
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(415, { error: 'JSON expected' });
        let body;
        try {
            body = JSON.parse((await readBody(req)) || '{}');
        } catch {
            return send(400, { error: 'invalid JSON' });
        }
        if (route === 'POST /enabled') {
            if (typeof body.enabled !== 'boolean') return send(400, { error: '"enabled" must be true or false' });
            await setEnabled(body.enabled);
            return send(200, status());
        }
        if (route === 'POST /scan') {
            scheduleScan(0);
            return send(200, status());
        }
        if (route === 'POST /retry') {
            state.failed = {};
            await saveState();
            scheduleScan(0);
            return send(200, status());
        }
    }
    return send(404, { error: 'not found' });
}

async function main() {
    await loadState();
    await fsp.unlink(config.socket).catch(() => {});
    const server = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
            log(`request failed: ${err.stack || err}`);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        });
    });
    server.listen(config.socket, () => {
        log(`listening on ${config.socket}, ${state.enabled ? 'on' : 'off (switch it on in the side panel of the web page)'}`);
    });
    if (state.enabled) scheduleScan(0);
    const stop = () => {
        if (current) {
            cancelled = true;
            currentChild?.kill('SIGTERM');
        }
        server.close();
        setTimeout(() => process.exit(0), 2000).unref();
        saving.then(() => { if (!current) process.exit(0); });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

module.exports = {
    parseJson5,
    isSettled,
    isBeingEdited,
    estimateSecondsLeft,
    getMetadataArgs,
    getOutFormat,
    shouldCopyStream,
    getCutArgs,
    getMergeArgs,
    getConcatList,
    formatTimecode,
    interpolateTemplate,
    getOutputName,
    normalizeSegments,
    getCleanup,
    cleanError,
    uniquePath,
    VIDEO_EXTENSIONS,
};

if (require.main === module) {
    main().catch((err) => {
        log(err.stack || err);
        process.exit(1);
    });
}
