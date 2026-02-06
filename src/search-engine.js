export const BUILTIN_SEARCH_ENGINES = {
  duckduckgo_noai: "https://noai.duckduckgo.com/?ia=web&q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  brave: "https://search.brave.com/search?q=%s",
  ecosia: "https://www.ecosia.org/search?q=%s",
  kagi: "https://kagi.com/search?q=%s",
  startpage: "https://www.startpage.com/sp/search?q=%s",
};

export function isBuiltInSearchEngine(tpl) {
  if (typeof tpl !== "string") return false;

  // Try parsing the URL safely, adding https:// if m520issing
  let parsed;
  try {
    parsed = new URL(tpl);
  } catch {
    try {
      parsed = new URL("https://" + tpl);
    } catch {
      return false; // Not a valid URL at all
    }
  }

  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();

  // Normalize for comparison (so "www.duckduckgo.com" → "duckduckgo.com")
  return Object.values(BUILTIN_SEARCH_ENGINES).some((engineUrl) => {
    try {
      const engineHost = new URL(engineUrl).hostname.replace(/^www\./i, "").toLowerCase();
      return host === engineHost; 
    } catch {
      return false;
    }
  });
}