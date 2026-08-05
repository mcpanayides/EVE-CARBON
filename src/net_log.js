'use strict';
//
// Opt-in network recorder — for answering "is the app hammering the network?"
// with data instead of a hypothesis.
//
// Off unless switched on, and it never changes request behaviour: every hook
// passes the call straight through and only records what went out.
//
// Enable EITHER way:
//   • set EVE_CARBON_NET_LOG=1 in the environment, or
//   • put "netLog": true under "app" in userData/config.json
//
// Writes two files into userData/:
//   net-log.csv       one row per request  (iso, source, method, host, path, status, ms)
//   net-summary.csv   one row per minute   (iso, requests, peakInFlight, top hosts)
//
// The per-minute file is the one that answers the question: a healthy idle app
// is a handful of requests per minute. A runaway poller or a retry storm shows
// up as a rising line, and peakInFlight shows whether it's also holding sockets
// open — the thing that actually degrades a connection.
const fs   = require('fs');
const path = require('path');

let enabled   = false;
let dir       = null;
let rowStream = null;
let sumStream = null;
let flushTimer = null;

let inFlight     = 0;
let peakInFlight = 0;
let minuteCount  = 0;
let byHost       = new Map();

// `served` distinguishes a real request from a disk-cache hit. Kept in one
// constant because init() compares it against an existing file's header to
// decide whether the schema changed under it.
const ROW_HEADER = 'iso,source,method,host,path,status,ms,served';

const iso = () => new Date().toISOString();
const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Loading the app's own HTML/CSS/JS off disk is not network traffic, and at ~77
// rows per launch it would bury the signal. Only real remote schemes are counted.
const LOCAL_SCHEME = /^(file|devtools|data|blob|chrome|chrome-extension):/i;

function record(source, method, url, status, ms, fromCache = false) {
  if (!enabled) return;
  if (LOCAL_SCHEME.test(String(url))) return;
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch { host = 'unparsed'; pathname = String(url).slice(0, 120); }
  if (!host) return;   // no host → not a remote request

  // A cache hit is NOT traffic. webRequest.onCompleted fires for responses the
  // disk cache served as well as ones that reached the network, so counting
  // rows without checking this over-reports network load — it did exactly that
  // here before the column existed, inflating an image count by ~3x.
  // Cache hits are still written (they show what the app *asked* for), but only
  // real requests count toward the per-minute totals.
  if (!fromCache) {
    minuteCount++;
    byHost.set(host, (byHost.get(host) || 0) + 1);
  }
  try {
    rowStream?.write([iso(), source, method, host, pathname, status, Math.round(ms),
                      fromCache ? 'cache' : 'net'].map(csv).join(',') + '\n');
  } catch (_) { /* logging must never break the app */ }
}

function flushMinute() {
  if (!enabled) return;
  const top = [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([h, n]) => `${h}=${n}`).join(' ');
  try {
    sumStream?.write([iso(), minuteCount, peakInFlight, top].map(csv).join(',') + '\n');
  } catch (_) {}
  minuteCount = 0;
  peakInFlight = inFlight;
  byHost = new Map();
}

// Wraps https.request / http.request once, so every main-process call is caught
// — httpGet, httpGetFull, httpPost, the global fetch wrapper and anything added
// later — without touching a single call site.
function instrumentNodeHttp() {
  for (const mod of ['https', 'http']) {
    const lib  = require(mod);
    const orig = lib.request;
    if (orig.__eveCarbonNetLog) continue;

    const wrapped = function (...args) {
      const started = Date.now();
      let url = '';
      try {
        const a = args[0];
        if (typeof a === 'string') url = a;
        else if (a instanceof URL) url = a.href;
        else if (a && typeof a === 'object') {
          url = `${mod}://${a.host || a.hostname || ''}${a.path || ''}`;
        }
      } catch (_) {}
      const method = (args.find(x => x && typeof x === 'object' && x.method) || {}).method || 'GET';

      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      let settled = false;
      const done = (status) => {
        if (settled) return;
        settled = true;
        inFlight--;
        record(mod, method, url, status, Date.now() - started);
      };

      const req = orig.apply(this, args);
      req.on('response', (res) => {
        // Count on 'end', not on headers — a socket held open for a slow body is
        // exactly the case worth seeing.
        res.on('end',   () => done(res.statusCode));
        res.on('close', () => done(res.statusCode));
      });
      req.on('error',   (e) => done('ERR:' + (e && e.code ? e.code : 'unknown')));
      req.on('timeout', ()  => done('TIMEOUT'));
      return req;
    };
    wrapped.__eveCarbonNetLog = true;
    lib.request = wrapped;

    // http(s).get calls through to request internally in Node, but it captured a
    // reference at module load — re-point it at the wrapper so it's covered too.
    const origGet = lib.get;
    if (!origGet.__eveCarbonNetLog) {
      const wrappedGet = function (...args) {
        const req = wrapped.apply(this, args);
        req.end();
        return req;
      };
      wrappedGet.__eveCarbonNetLog = true;
      lib.get = wrappedGet;
    }
  }
}

// Renderer-side traffic (window.fetch / XHR) never touches Node's http module,
// so it needs the session hook to be counted at all.
function instrumentSession(session) {
  try {
    const started = new Map();
    session.webRequest.onBeforeRequest((details, cb) => {
      started.set(details.id, Date.now());
      cb({});
    });
    session.webRequest.onCompleted((details) => {
      const t0 = started.get(details.id);
      started.delete(details.id);
      record('renderer', details.method, details.url, details.statusCode, t0 ? Date.now() - t0 : 0, !!details.fromCache);
    });
    session.webRequest.onErrorOccurred((details) => {
      const t0 = started.get(details.id);
      started.delete(details.id);
      record('renderer', details.method, details.url, 'ERR:' + (details.error || ''), t0 ? Date.now() - t0 : 0);
    });
  } catch (e) {
    console.warn('[net-log] session hook failed:', e.message);
  }
}

/**
 * @param {object}   opts
 * @param {string}   opts.userDataPath  where the CSVs are written
 * @param {object}   opts.config        parsed config.json (reads app.netLog)
 * @param {object=}  opts.session       Electron session to hook for renderer traffic
 * @returns {boolean} whether recording is on
 */
function init({ userDataPath, config, session }) {
  const fromEnv = /^(1|true|yes)$/i.test(String(process.env.EVE_CARBON_NET_LOG || ''));
  const fromCfg = !!(config && config.app && config.app.netLog);
  enabled = fromEnv || fromCfg;
  if (!enabled) return false;

  dir = userDataPath;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rowPath = path.join(dir, 'net-log.csv');
    const sumPath = path.join(dir, 'net-summary.csv');
    // Schema changed? Archive the old file rather than appending rows with a
    // different column count into it — a half-and-half CSV analyses wrong.
    if (fs.existsSync(rowPath)) {
      const head = String(fs.readFileSync(rowPath, 'utf8')).split(/\r?\n/, 1)[0].trim();
      if (head && head !== ROW_HEADER) {
        fs.renameSync(rowPath, rowPath.replace(/\.csv$/, `.${Date.now()}.csv`));
      }
    }
    const fresh   = !fs.existsSync(rowPath);
    rowStream = fs.createWriteStream(rowPath, { flags: 'a' });
    sumStream = fs.createWriteStream(sumPath, { flags: 'a' });
    if (fresh) {
      rowStream.write(ROW_HEADER + '\n');
      sumStream.write('iso,requests,peakInFlight,topHosts\n');
    }
  } catch (e) {
    console.warn('[net-log] could not open log files:', e.message);
    enabled = false;
    return false;
  }

  instrumentNodeHttp();
  if (session) instrumentSession(session);
  flushTimer = setInterval(flushMinute, 60 * 1000);
  if (flushTimer.unref) flushTimer.unref();

  console.log(`[net-log] recording to ${path.join(dir, 'net-log.csv')} and net-summary.csv`);
  return true;
}

function stop() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  try { flushMinute(); } catch (_) {}
  try { rowStream?.end(); sumStream?.end(); } catch (_) {}
  enabled = false;
}

module.exports = { init, stop, isEnabled: () => enabled };
