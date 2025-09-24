// Manifest localization utilities

import path from 'path';
import { promises as fs } from 'fs';

/**
 * Build locale candidate order from app/default locales
 * @param {string} appLocale
 * @param {string} defaultLocale
 */
export function buildLocaleCandidates(appLocale, defaultLocale) {
  const norm = (s) => String(s || '').replace('-', '_');
  const lc = norm(appLocale);
  const base = lc.split(/[-_]/)[0];
  const def = norm(defaultLocale);
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  push(lc);
  push(base);
  push(def);
  push('en');
  return out;
}

/**
 * Resolve i18n placeholders from _locales messages.json
 * @param {string} installedPath
 * @param {Object} manifest
 * @param {string} [appLocale]
 * @param {string} [fallbackDefault]
 * @returns {Promise<{name: string, description: string}>}
 */
export async function resolveManifestStrings(installedPath, manifest, appLocale = 'en', fallbackDefault = 'en') {
  try {
    const defaultLocale = String(manifest?.default_locale || '').trim() || fallbackDefault || 'en';
    const candidates = buildLocaleCandidates(appLocale, defaultLocale);

    let messages = null;
    for (const loc of candidates) {
      try {
        const p = path.join(installedPath, '_locales', loc, 'messages.json');
        const raw = await fs.readFile(p, 'utf8');
        messages = JSON.parse(raw);
        break;
      } catch (_) {}
    }

    const resolveMsg = (val) => {
      if (!val || typeof val !== 'string') return val || '';
      const m = /^__MSG_([A-Za-z0-9_]+)__$/i.exec(val);
      if (!m || !messages) return val;
      const key = m[1];
      const entry = messages[key];
      const text = entry && (entry.message || entry.value);
      return typeof text === 'string' && text.length ? text : val;
    };

    return {
      name: resolveMsg(manifest?.name),
      description: resolveMsg(manifest?.description)
    };
  } catch (_) {
    return { name: manifest?.name, description: manifest?.description || '' };
  }
}

