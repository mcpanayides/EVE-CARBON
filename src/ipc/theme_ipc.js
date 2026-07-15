// theme_ipc.js — palette / theme management IPC handlers
// Themes are plain CSS files of custom properties with @-metadata comments:
//   • Built-in themes:    src/styles/theme-*.css (shipped with the app)
//   • User-created themes: userData/themes/*.css (written by theme-save-custom)
// Legacy user themes saved as YAML (pre-CSS format) are migrated to .css on
// startup; the originals are kept as *.bak.

const fs   = require('fs');
const path = require('path');
const ThemeVars = require('../shared/theme-vars');

function registerThemeHandlers({ ipcHandle, app, loadConfig, saveConfig, userThemesDir }) {

  const builtinDir = path.join(path.dirname(__dirname), 'styles');

  function readThemeFile(p) {
    try {
      const meta = ThemeVars.parseThemeCssMeta(fs.readFileSync(p, 'utf8'));
      return meta?.name ? meta : null;
    } catch { return null; }
  }

  function builtinFiles() {
    try {
      return fs.readdirSync(builtinDir).filter(f => /^theme-.*\.css$/.test(f));
    } catch { return []; }
  }

  function resolveTheme(id) {
    if (!id) return null;
    if (id.startsWith('user:')) {
      const p = path.join(userThemesDir, path.basename(id.slice(5)));
      const meta = fs.existsSync(p) ? readThemeFile(p) : null;
      return meta ? { meta, source: 'user', path: p } : null;
    }
    for (const file of builtinFiles()) {
      const p    = path.join(builtinDir, file);
      const meta = readThemeFile(p);
      if (meta && (meta.id === id || meta.name === id)) {
        return { meta, source: 'builtin', path: p, file };
      }
    }
    return null;
  }

  function themePayload(id, resolved) {
    const { meta, source, path: p, file } = resolved;
    return {
      id,
      source,
      name:        meta.name        || id,
      description: meta.description || '',
      author:      meta.author      || '',
      roles:       meta.roles       || null,
      swatches:    meta.swatches    || null,
      // Renderer builds the stylesheet href from one of these:
      file:        source === 'builtin' ? file : null,   // relative to styles/
      path:        source === 'user'    ? p    : null,   // absolute
    };
  }

  // ── One-time migration: legacy YAML user themes → CSS files ────────────────
  function migrateLegacyYamlThemes() {
    let files;
    try { files = fs.readdirSync(userThemesDir).filter(f => /\.(yaml|yml)$/.test(f)); }
    catch { return; }
    if (!files.length) return;

    const jsy = require('js-yaml');
    for (const file of files) {
      const yamlPath = path.join(userThemesDir, file);
      try {
        const data = jsy.load(fs.readFileSync(yamlPath, 'utf8'));
        if (data?.swatches) {
          const safe    = (data.name || path.basename(file, path.extname(file)))
                            .replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'custom';
          const cssFile = `${safe}.css`;
          const cssPath = path.join(userThemesDir, cssFile);
          if (!fs.existsSync(cssPath)) {
            fs.writeFileSync(cssPath, ThemeVars.buildThemeCssFileText({
              id:          `user:${cssFile}`,
              name:        data.name || safe,
              description: data.description || '',
              author:      data.author || '',
              roles:       data.roles || { accent: 'red', danger: 'red', success: 'green', warning: 'orange', info: 'blue' },
              swatches:    data.swatches,
            }));
          }
          // Re-point the active-theme config entry at the migrated file
          const cfg = loadConfig();
          if (cfg?.app?.theme === `user:${file}`) {
            cfg.app.theme = `user:${cssFile}`;
            saveConfig(cfg);
          }
        }
        fs.renameSync(yamlPath, `${yamlPath}.bak`);
      } catch (e) {
        console.warn(`[theme] YAML theme migration failed for ${file}:`, e.message);
      }
    }
  }
  migrateLegacyYamlThemes();

  // List all available themes (built-in + user)
  ipcHandle('theme-get-all', () => {
    const themes = [];
    for (const file of builtinFiles()) {
      const meta = readThemeFile(path.join(builtinDir, file));
      if (meta) themes.push({
        id: meta.id || meta.name, source: 'builtin',
        name: meta.name, description: meta.description || '', author: meta.author || '',
      });
    }
    try {
      for (const file of fs.readdirSync(userThemesDir).filter(f => /\.css$/.test(f))) {
        const meta = readThemeFile(path.join(userThemesDir, file));
        if (meta) themes.push({
          id: `user:${file}`, source: 'user',
          name: meta.name, description: meta.description || '', author: meta.author || '',
        });
      }
    } catch { /* no user themes dir yet */ }
    return themes;
  });

  // Return the theme metadata + stylesheet location for a given id
  ipcHandle('theme-get', (_, id) => {
    const resolved = resolveTheme(id);
    return resolved ? themePayload(id, resolved) : null;
  });

  // Get / set the active theme id in config
  ipcHandle('theme-get-active', () => {
    return loadConfig()?.app?.theme || 'Carbon';
  });

  ipcHandle('theme-set-active', (_, id) => {
    const cfg = loadConfig();
    cfg.app = cfg.app || {};
    cfg.app.theme = id;
    saveConfig(cfg);
    return true;
  });

  // Save a user-created theme (simplified 16-swatch format)
  // payload: { name, roles, swatches: { red, teal, … , background, panel, text, border } }
  ipcHandle('theme-save-custom', (_, payload) => {
    if (!payload?.name || !payload?.swatches) return { success: false, error: 'Missing name or swatches' };
    try {
      if (!fs.existsSync(userThemesDir)) fs.mkdirSync(userThemesDir, { recursive: true });
      const safe = payload.name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'custom';
      const file = `${safe}.css`;
      fs.writeFileSync(path.join(userThemesDir, file), ThemeVars.buildThemeCssFileText({
        id:          `user:${file}`,
        name:        payload.name,
        description: payload.description || '',
        author:      payload.author || '',
        roles:       payload.roles || { accent: 'red', danger: 'red', success: 'green', warning: 'orange', info: 'blue' },
        swatches:    payload.swatches,
      }));
      return { success: true, id: `user:${file}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Delete a user-created theme
  ipcHandle('theme-delete-custom', (_, id) => {
    if (!id?.startsWith('user:')) return { success: false, error: 'Cannot delete built-in themes' };
    try {
      const p = path.join(userThemesDir, path.basename(id.slice(5)));
      if (!fs.existsSync(p)) return { success: false, error: 'File not found' };
      fs.unlinkSync(p);
      // If this was the active theme, fall back to Carbon
      const cfg = loadConfig();
      if (cfg?.app?.theme === id) {
        cfg.app.theme = 'Carbon';
        saveConfig(cfg);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerThemeHandlers };
