'use strict';
//
// Opt-in diagnostic log — the thing that turns "it broke yesterday" into
// something a maintainer can act on.
//
// The app already has an in-window console (logToConsole in src/utils.js), but
// it holds 200 lines in memory and is gone the moment the app closes. A bug that
// happened last night, or one that took the app down with it, leaves nothing
// behind. This writes the same stream to disk so a bug report can carry it.
//
// OFF BY DEFAULT, and switched on from Settings → General. Recording what an
// application does is not something to start doing on somebody's behalf.
//
// ── Why redaction is not optional here ───────────────────────────────────────
//
// The bug report tool opens a PUBLIC GitHub issue. This app authenticates to EVE
// SSO and holds access and refresh tokens, and an unredacted log of a failed
// request can carry one verbatim. A refresh token pasted into a public tracker
// is a full account compromise that the reporter cannot undo — the issue is
// indexed within minutes.
//
// So every line is scrubbed on the way IN, not on the way out. Scrubbing at read
// time would leave the secret sitting in a file on disk, and would be one
// forgotten code path away from leaking anyway. The file itself is safe to send.
//
// The home directory is scrubbed too: "C:\Users\Jane Smith\..." is a real name,
// and a bug report should not publish one.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const LOG_NAME     = 'eve-carbon.log';
const MAX_BYTES    = 4 * 1024 * 1024;   // rotate past this
const KEEP_ROTATED = 1;                 // ...and keep one previous file
// How much of the tail a bug report may carry. A GitHub issue is submitted as a
// URL, and browsers start failing somewhere past ~8k characters — so the log has
// to leave room for the report the user actually wrote.
const TAIL_LINES   = 120;
const TAIL_CHARS   = 3000;
// Reading the whole file to get its last few lines would mean loading megabytes
// to show a hundred lines.
const TAIL_WINDOW  = 256 * 1024;

/**
 * Patterns that must never reach the file.
 *
 * Deliberately greedy: over-redacting costs a maintainer one round trip asking
 * for detail, while under-redacting costs the reporter their account. Where the
 * two conflict, the pattern stays broad.
 */
const REDACTIONS = [
  // Whole JWTs, wherever they appear — this is the shape ESI tokens take.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'],
  [/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,                      '$1[redacted]'],
  [/(access[_-]?token\s*["':=]+\s*"?)[^"'&,\s}]+/gi,          '$1[redacted]'],
  [/(refresh[_-]?token\s*["':=]+\s*"?)[^"'&,\s}]+/gi,         '$1[redacted]'],
  [/(client[_-]?secret\s*["':=]+\s*"?)[^"'&,\s}]+/gi,         '$1[redacted]'],
  // Catch-all for an auth header whose value is not a Bearer token. The
  // lookahead keeps it off values the rule above already handled — without it
  // "Authorization: Bearer [redacted]" collapses to "[redacted] [redacted]",
  // which is still safe but throws away the fact that it was an auth failure.
  [/(authorization\s*["':=]+\s*"?)(?!Bearer\b|\[redacted\])[^"'&,\s}]+/gi, '$1[redacted]'],
  // The OAuth callback: `code` is exchangeable for tokens until it is used.
  [/\b(code|state)=[^&\s"']+/gi,                              '$1=[redacted]'],
];

/** Scrub one line. Always applied before anything is written. */
function redact(text, homeDir = os.homedir()) {
  let s = String(text == null ? '' : text);
  for (const [re, sub] of REDACTIONS) s = s.replace(re, sub);
  if (homeDir && homeDir.length > 3) {
    // Both separators, because paths arrive from Node and from Windows APIs in
    // whichever form each produced.
    const variants = [homeDir, homeDir.replace(/\\/g, '/')];
    for (const v of variants) {
      if (!v) continue;
      s = s.split(v).join('~');
    }
  }
  return s;
}

let enabled  = false;
let filePath = null;
let dirPath  = null;
let fd       = null;
let writing  = false;   // guards against console capture recursing

const iso = () => new Date().toISOString();

/** One entry is one line, so tail() can count them without parsing. */
function formatLine(level, source, message) {
  const flat = redact(message).replace(/\r?\n/g, ' ⏎ ');
  return `${iso()} ${String(level || 'info').toUpperCase().padEnd(5)} [${source || 'app'}] ${flat}\n`;
}

function rotateIfNeeded() {
  if (!filePath) return;
  let size = 0;
  try { size = fs.fstatSync(fd).size; } catch (_) { return; }
  if (size < MAX_BYTES) return;
  try {
    closeFd();
    const rotated = `${filePath}.1`;
    if (KEEP_ROTATED > 0) {
      try { fs.rmSync(rotated, { force: true }); } catch (_) {}
      fs.renameSync(filePath, rotated);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  } catch (_) { /* keep logging to the existing file rather than dying */ }
  openFd();
}

function closeFd() {
  if (fd == null) return;
  try { fs.closeSync(fd); } catch (_) {}
  fd = null;
}

function openFd() {
  if (!filePath || fd != null) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fd = fs.openSync(filePath, 'a');
  } catch (_) { fd = null; enabled = false; }
}

/**
 * Record one line. Silent no-op when disabled — every call site is a hot path
 * that must not care whether logging is on.
 *
 * WRITES SYNCHRONOUSLY, on purpose. A buffered stream loses whatever is still in
 * the buffer when the process dies, and for a diagnostic log that is precisely
 * the wrong data to lose: the lines immediately before a crash are the entire
 * reason someone switched this on. The cost is a small synchronous append to a
 * local file at diagnostic volume, which is not a rate this app writes at.
 */
function write(level, source, message) {
  if (!enabled || fd == null || writing) return;
  writing = true;
  try {
    fs.writeSync(fd, formatLine(level, source, message));
    rotateIfNeeded();
  } catch (_) {
    // A full or read-only disk must not take the app down with it, and must not
    // spin retrying on every subsequent line either.
    enabled = false;
    closeFd();
  } finally { writing = false; }
}

/**
 * Mirror the main process's own console into the file.
 *
 * Main-process errors are exactly what a bug report is missing today — they go
 * to a terminal nobody packaged, so a crash in a background poller is invisible.
 * The original console is always called first, so behaviour with logging off is
 * byte-identical to before.
 */
let consoleCaptured = false;
function captureConsole() {
  // Once only. Wrapping an already-wrapped console nests the wrappers, so each
  // init() would add another layer and every line would be written once per
  // layer — which is both wrong and unbounded.
  if (consoleCaptured) return;
  consoleCaptured = true;
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      if (!enabled) return;
      try {
        write(level === 'log' ? 'info' : level, 'main',
              args.map(a => (a instanceof Error ? (a.stack || a.message)
                          : typeof a === 'object' ? safeJson(a) : String(a))).join(' '));
      } catch (_) {}
    };
  }
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch (_) { return '[unserialisable]'; }
}

/**
 * @param {object} opts
 * @param {string} opts.userDataPath  where the file lives
 * @param {object} [opts.config]      app config; config.app.fileLog turns it on
 */
function init({ userDataPath, config } = {}) {
  dirPath  = userDataPath || null;
  filePath = dirPath ? path.join(dirPath, LOG_NAME) : null;
  const fromCfg = !!(config && config.app && config.app.fileLog);
  captureConsole();
  if (fromCfg) setEnabled(true);
  return enabled;
}

function setEnabled(on) {
  const want = !!on;
  if (want === enabled) return enabled;
  if (want) {
    if (!filePath) return false;
    openFd();
    enabled = fd != null;
    if (enabled) {
      write('info', 'log', `--- logging started · EVE Carbon on ${process.platform} ---`);
    }
  } else {
    write('info', 'log', '--- logging stopped ---');
    enabled = false;
    closeFd();
  }
  return enabled;
}

/** Size and location, for the Settings row. */
function stat() {
  let bytes = 0, exists = false;
  try { bytes = fs.statSync(filePath).size; exists = true; } catch (_) {}
  return { enabled, path: filePath, dir: dirPath, bytes, exists };
}

/**
 * The last lines, for a bug report.
 *
 * Bounded twice — by lines and by characters — because the report is delivered
 * as a URL and an oversized one silently fails to open rather than erroring.
 */
function tail({ lines = TAIL_LINES, chars = TAIL_CHARS } = {}) {
  if (!filePath) return '';
  let fd = null;
  try {
    const size = fs.statSync(filePath).size;
    const from = Math.max(0, size - TAIL_WINDOW);
    const len  = size - from;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, from);
    let text = buf.toString('utf8');
    // A partial first line from cutting mid-file would be noise.
    if (from > 0) text = text.slice(text.indexOf('\n') + 1);

    let out = text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
    if (out.length > chars) out = '…\n' + out.slice(out.length - chars);
    // Belt and braces: the file was scrubbed on the way in, but this is the text
    // that actually gets published, so it is scrubbed again on the way out.
    return redact(out);
  } catch (_) {
    return '';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

function clear() {
  try {
    closeFd();
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.1`, { force: true });
  } catch (_) {}
  if (enabled) { openFd(); write('info', 'log', '--- log cleared ---'); }
  return stat();
}

function stop() {
  closeFd();
  enabled = false;
}

module.exports = {
  init, setEnabled, write, stat, tail, clear, stop, redact,
  isEnabled: () => enabled,
  LOG_NAME, MAX_BYTES, TAIL_LINES, TAIL_CHARS,
};
