const axios = require('axios');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SDE_URL     = 'https://www.fuzzwork.co.uk/dump/latest-sqlite.db.gz';
const DATA_DIR    = path.join(__dirname, '../data');
const OUT_FILE    = path.join(DATA_DIR, 'sde.sql');
// Fuzzwork no longer publishes a .md5 sidecar for the gz dump, so we use the
// remote Last-Modified header as the version token. Kept in sde.md5 for
// backwards compatibility with the existing path the app reads.
const VER_FILE    = path.join(DATA_DIR, 'sde.md5');

async function fetchRemoteVersion() {
    const response = await axios.head(SDE_URL);
    return response.headers['last-modified'] || response.headers['etag'] || null;
}

function readLocalVersion() {
    try { return fs.readFileSync(VER_FILE, 'utf8').trim(); }
    catch { return null; }
}

async function downloadSDE() {
    console.log('Creating /data directory...');
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    console.log('Checking remote SDE version...');
    let remoteVer;
    try {
        remoteVer = await fetchRemoteVersion();
        console.log(`Remote version : ${remoteVer}`);
    } catch (e) {
        console.warn(`Could not fetch remote version (${e.message}), proceeding with download.`);
    }

    const localVer = readLocalVersion();
    console.log(`Local version  : ${localVer || '(none)'}`);

    if (remoteVer && localVer === remoteVer && fs.existsSync(OUT_FILE)) {
        console.log('SDE is already up to date. Skipping download.');
        return;
    }

    console.log(`Downloading latest Fuzzwork SDE from ${SDE_URL}...`);

    try {
        const response = await axios({
            method: 'get',
            url: SDE_URL,
            responseType: 'stream',
            timeout: 0,                 // no overall timeout for a large download
        });

        const total   = parseInt(response.headers['content-length'] || '0', 10);
        const tmpFile = OUT_FILE + '.tmp';   // write to temp, rename on success
        const writer  = fs.createWriteStream(tmpFile);
        const gunzip  = zlib.createGunzip();

        // Live progress so a multi-hundred-MB download doesn't look frozen.
        let downloaded = 0;
        let lastLog    = 0;
        response.data.on('data', chunk => {
            downloaded += chunk.length;
            const now = Date.now();
            if (now - lastLog > 750) {
                lastLog = now;
                const mb = (downloaded / 1048576).toFixed(1);
                const line = total
                    ? `  Downloaded ${mb} / ${(total / 1048576).toFixed(1)} MB`
                    : `  Downloaded ${mb} MB (compressed)`;
                process.stdout.write(`\r${line}      `);
            }
        });

        // Pipe the download through the gzip decompressor and into the temp file.
        try {
            await new Promise((resolve, reject) => {
                response.data.on('error', reject);
                gunzip.on('error', reject);
                writer.on('error', reject);
                writer.on('finish', resolve);
                response.data.pipe(gunzip).pipe(writer);
            });
        } catch (e) {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            throw e;
        }
        process.stdout.write('\n');

        // Atomically replace the live file only after a clean, complete download.
        fs.renameSync(tmpFile, OUT_FILE);

        console.log('SDE successfully downloaded and uncompressed to /data/sde.sql');

        // Save the version token so future runs can skip unnecessary downloads
        if (remoteVer) {
            fs.writeFileSync(VER_FILE, remoteVer, 'utf8');
            console.log(`Version saved to ${VER_FILE}`);
        }

    } catch (error) {
        console.error('Failed to download SDE:', error.message);
        process.exit(1);
    }
}

downloadSDE();
