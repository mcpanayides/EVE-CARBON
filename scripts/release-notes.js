'use strict';
// The release notes, for .github/workflows/main.yml.
//
//   node scripts/release-notes.js write v4.1.4 RELEASE_NOTES.md
//   node scripts/release-notes.js check v4.1.4 release.json     (gh api …/releases/tags/v4.1.4)
//
// The notes are the CHANGELOG.md section for the tag, so every release gets its
// own; only a tag with no section falls back to the newest one.
//
// BOTH build jobs write them. Only the Windows job used to, and on v4.1.4 the Mac
// job published a second apart from it: the release came out with no notes, and
// with them went the critical flag the in-app updater reads from there.
const fs = require('fs');
const path = require('path');

/** The section for a version ("4.1.4"), or the newest; { version, text }. */
function releaseNotes(changelog, version) {
  const sections = String(changelog).replace(/\r/g, '').split(/^(?=## \[)/m).filter(s => s.startsWith('## ['));
  const name = (s) => (/^## \[([^\]]+)\]/.exec(s) || [])[1];
  const own = sections.find(s => name(s) === version);
  const text = own || sections[0] || '';
  return { version: name(text) || null, text: text.trimEnd() + '\n' };
}

/** What is wrong with a published release (GitHub's JSON), as sentences. */
function releaseProblems(release, notes) {
  const same = (s) => String(s || '').replace(/\r/g, '').trim();
  const out = [];
  if (!same(release.body)) out.push('the release has no notes');
  else if (same(release.body) !== same(notes)) out.push('the release notes are not the changelog section');
  for (const ext of ['.exe', '.dmg']) {
    if (!(release.assets || []).some(a => a.name.endsWith(ext) && a.state === 'uploaded')) out.push(`no ${ext} on the release`);
  }
  if (release.draft) out.push('it is still a draft');
  if (release.prerelease) out.push('it is a pre-release, which installed apps do not see');
  return out;
}

if (require.main === module) {
  const [cmd, tag, file] = process.argv.slice(2);
  const version = String(tag || '').replace(/^v/, '');
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const notes = releaseNotes(changelog, version);
  if (cmd === 'write') {
    if (notes.version !== version) console.log(`No changelog section for ${version}: using ${notes.version}`);
    fs.writeFileSync(file, notes.text);
  } else if (cmd === 'check') {
    const problems = releaseProblems(JSON.parse(fs.readFileSync(file, 'utf8')), notes.text);
    for (const p of problems) console.log(`::error::${tag}: ${p}`);
    if (problems.length) {
      console.log(`Repair the notes with: node scripts/release-notes.js write ${tag} notes.md && gh release edit ${tag} --notes-file notes.md`);
      process.exit(1);
    }
    console.log(`${tag}: notes and both installers are up.`);
  } else {
    console.error('usage: release-notes.js write|check <tag> <file>');
    process.exit(2);
  }
}

module.exports = { releaseNotes, releaseProblems };
