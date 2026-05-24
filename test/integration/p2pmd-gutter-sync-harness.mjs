import path from "path";
import os from "os";
import fs from "fs/promises";
import electron from "electron";

const { app, BrowserWindow } = electron;

const RESULT_PREFIX = "__PEERSKY_RESULT__";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key && key.startsWith("--") && value !== undefined) {
      args[key.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

const cliArgs = parseArgs(process.argv.slice(2));

const ROOM_URL = cliArgs["room-url"] || "http://127.0.0.1:9999";
const USER_DATA_ROOT = cliArgs["user-data"] || os.tmpdir();
const TEST_KEY = "hs://0000e2eguttersynctestruntimekey000000000000000000000000";

const BOOT_TIMEOUT_MS = 25_000;
const EDITOR_READY_TIMEOUT_MS = 30_000;
const BETWEEN_PASTE_MS = 1_600;
const CONVERGENCE_TIMEOUT_MS = 40_000;

const PEERS = [
  { name: "person1", color: "#e53e3e", clientId: "e2e-peer-1", role: "host" },
  { name: "person2", color: "#38a169", clientId: "e2e-peer-2", role: "client" },
  { name: "person3", color: "#3182ce", clientId: "e2e-peer-3", role: "client" },
];

const PERSON1_BLOCK = "# person1\n- line1\n- line2\n- line3";
const PERSON2_BLOCK = "# person2\n- line1\n- line2\n- line3";
const PERSON3_BLOCK = "# person3\n- line1\n- line2\n- line3";
const TOP_LINE_1 = "first line after block by person1";
const TOP_LINE_2 = "second line after block by person 2";
const TOP_LINE_3 = "third line after block by person 3";
const PERSON3_EXTRA_BLANK_COUNT = 6;
const TRAILING_SPACES_COUNT = 6;

const EXPECTED_FINAL_TEXT =
  "second line after block by person 2\nthird line after block by person 3\n\n# person3\n- line1\n- line2\n- line3\n\n# person1\n- line1\n- line2\n- line3\n\n# person2\n- line1\n- line2\n- line3";

function emitResult(payload) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(payload)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeExec(win, code, label = "executeJavaScript", timeoutMs = 12_000) {
  try {
    return await withTimeout(win.webContents.executeJavaScript(code, true), timeoutMs, label);
  } catch (error) {
    return { __error: String(error?.message || error) };
  }
}

async function waitForEditorReady(win) {
  const started = Date.now();
  while (Date.now() - started < EDITOR_READY_TIMEOUT_MS) {
    const ready = await safeExec(
      win,
      `Boolean(document.getElementById("markdownInput")) && !document.getElementById("editor-page")?.classList.contains("hidden")`,
      "waitForEditorReady"
    );
    if (ready === true) return true;
    await sleep(500);
  }
  return false;
}

async function openPeerWindow(peer, index) {
  const pagePath = path.resolve("src/pages/p2p/p2pmd/index.html");

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    x: index * 80,
    y: index * 80,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      partition: `persist:p2pmd-e2e-${peer.clientId}`,
    },
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[harness] did-fail-load (${peer.name}) code=${code} desc=${desc} url=${url}`);
  });

  console.log(`[harness] opening ${peer.name}`);
  await withTimeout(win.loadFile(pagePath), BOOT_TIMEOUT_MS, `loadFile(${peer.name})`);

  await safeExec(
    win,
    `
      localStorage.setItem("p2pmd-display-name", ${JSON.stringify(peer.name)});
      localStorage.setItem("p2pmd-user-color", ${JSON.stringify(peer.color)});
      localStorage.setItem("p2pmd-client-id", ${JSON.stringify(peer.clientId)});
      const onboardingInput = document.getElementById("onboarding-name");
      if (onboardingInput) onboardingInput.value = ${JSON.stringify(peer.name)};
      true;
    `,
    `setIdentity(${peer.name})`
  );

  const roomPort = String(new URL(ROOM_URL).port || "");
  await safeExec(
    win,
    `
      (() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async function(input, init) {
          const raw = typeof input === "string" ? input : (input && input.url) || "";
          if (raw.startsWith("hs://p2pmd")) {
            const u = new URL(raw);
            const action = u.searchParams.get("action") || "";
            if (["join", "create", "rehost"].includes(action)) {
              return new Response(JSON.stringify({
                ok: true,
                key: ${JSON.stringify(TEST_KEY)},
                localUrl: ${JSON.stringify(ROOM_URL)},
                localHost: "127.0.0.1",
                localPort: ${JSON.stringify(roomPort)},
                secure: false,
                udp: false,
              }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
          }
          return originalFetch(input, init);
        };
      })();
      true;
    `,
    `patchFetch(${peer.name})`
  );

  await safeExec(
    win,
    `
      (async () => {
        const onboarding = document.getElementById("onboarding-page");
        if (onboarding && !onboarding.classList.contains("hidden")) {
          document.getElementById("onboard-submit")?.click();
          await new Promise((r) => setTimeout(r, 400));
        }
        return true;
      })();
    `,
    `onboarding(${peer.name})`
  );

  await safeExec(
    win,
    `
      (() => {
        const joinInput = document.getElementById("join-room-key");
        const joinForm = document.getElementById("join-form");
        if (!joinInput || !joinForm) return { ok: false, reason: "join controls missing" };
        joinInput.value = ${JSON.stringify(TEST_KEY)};
        joinForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return { ok: true };
      })();
    `,
    `joinSubmit(${peer.name})`
  );

  const editorReady = await waitForEditorReady(win);
  if (!editorReady) {
    throw new Error(`Editor did not become ready for ${peer.name}`);
  }

  return win;
}

async function pasteBlock(win, block, prepend) {
  return safeExec(
    win,
    `
      (() => {
        const ta = document.getElementById("markdownInput");
        if (!ta) return { ok: false, reason: "markdownInput missing" };
        const current = ta.value || "";
        const block = ${JSON.stringify(block)};
        const next = ${prepend}
          ? (current ? (block + "\\n\\n" + current) : block)
          : (current ? (current + "\\n\\n" + block) : block);
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, length: next.length };
      })();
    `,
    "pasteBlock"
  );
}

async function insertTopLineAtIndex(win, lineText, index, ensureBlankAfterTop = false) {
  return safeExec(
    win,
    `
      (() => {
        const ta = document.getElementById("markdownInput");
        if (!ta) return { ok: false, reason: "markdownInput missing" };
        const current = ta.value || "";
        const lines = current.length > 0 ? current.split("\\n") : [];
        const idx = Math.max(0, Math.min(${index}, lines.length));
        lines.splice(idx, 0, ${JSON.stringify(lineText)});
        if (${ensureBlankAfterTop ? "true" : "false"}) {
          const topCount = idx + 1;
          if (lines[topCount] !== "") {
            lines.splice(topCount, 0, "");
          }
        }
        const next = lines.join("\\n");
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, length: next.length };
      })();
    `,
    "insertTopLineAtIndex"
  );
}

async function deleteLineAtIndex(win, index) {
  return safeExec(
    win,
    `
      (() => {
        const ta = document.getElementById("markdownInput");
        if (!ta) return { ok: false, reason: "markdownInput missing" };
        const current = ta.value || "";
        const lines = current.length > 0 ? current.split("\\n") : [];
        const idx = Math.max(0, Math.min(${index}, Math.max(0, lines.length - 1)));
        if (lines.length === 0) return { ok: true, length: 0 };
        lines.splice(idx, 1);
        const next = lines.join("\\n");
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, length: next.length };
      })();
    `,
    "deleteLineAtIndex"
  );
}

async function insertBlankLinesAfterPerson3Block(win, blankCount = PERSON3_EXTRA_BLANK_COUNT) {
  return safeExec(
    win,
    `
      (() => {
        const ta = document.getElementById("markdownInput");
        if (!ta) return { ok: false, reason: "markdownInput missing" };
        const block = ${JSON.stringify(PERSON3_BLOCK)};
        const spacer = "\\n".repeat(${blankCount});
        const current = ta.value || "";
        const idx = current.indexOf(block);
        if (idx < 0) return { ok: false, reason: "person3 block not found" };
        const insertAt = idx + block.length;
        const next = current.slice(0, insertAt) + spacer + current.slice(insertAt);
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, length: next.length };
      })();
    `,
    "insertBlankLinesAfterPerson3Block"
  );
}

async function removeBlankLinesAfterPerson3Block(win, blankCount = PERSON3_EXTRA_BLANK_COUNT) {
  return safeExec(
    win,
    `
      (() => {
        const ta = document.getElementById("markdownInput");
        if (!ta) return { ok: false, reason: "markdownInput missing" };
        const block = ${JSON.stringify(PERSON3_BLOCK)};
        const withSpacer = block + "\\n".repeat(${blankCount});
        const current = ta.value || "";
        const idx = current.indexOf(withSpacer);
        if (idx < 0) return { ok: false, reason: "person3 block + spacer not found" };
        const next = current.slice(0, idx) + block + current.slice(idx + withSpacer.length);
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, length: next.length };
      })();
    `,
    "removeBlankLinesAfterPerson3Block"
  );
}

async function addTrailingSpacesToTopLine3(win, spacesCount = TRAILING_SPACES_COUNT) {
  return safeExec(
    win,
    `
      (() => {
        const ta = document.getElementById("markdownInput");
        if (!ta) return { ok: false, reason: "markdownInput missing" };
        const target = ${JSON.stringify(TOP_LINE_3)};
        const current = ta.value || "";
        const lines = current.split("\\n");
        const idx = lines.findIndex((line) => line === target);
        if (idx < 0) return { ok: false, reason: "top line 3 not found" };
        lines[idx] = target + " ".repeat(${spacesCount});
        const next = lines.join("\\n");
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, length: next.length };
      })();
    `,
    "addTrailingSpacesToTopLine3"
  );
}

async function removeTrailingSpacesFromTopLine3(win) {
  return safeExec(
    win,
    `
      (() => {
        const ta = document.getElementById("markdownInput");
        if (!ta) return { ok: false, reason: "markdownInput missing" };
        const target = ${JSON.stringify(TOP_LINE_3)};
        const current = ta.value || "";
        const lines = current.split("\\n");
        const idx = lines.findIndex((line) => line.startsWith(target));
        if (idx < 0) return { ok: false, reason: "top line 3 not found" };
        lines[idx] = target;
        const next = lines.join("\\n");
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, length: next.length };
      })();
    `,
    "removeTrailingSpacesFromTopLine3"
  );
}

async function getText(win) {
  return safeExec(win, `document.getElementById("markdownInput")?.value || ""`, "getText");
}

async function getGutterMarks(win) {
  return safeExec(
    win,
    `
      (() => {
        const gutter = document.getElementById("author-gutter");
        const ta = document.getElementById("markdownInput");
        if (!gutter || !ta) return { marks: [], metrics: null };
        const cs = window.getComputedStyle(ta);
        const lineHeight = parseFloat(cs.lineHeight) || 20;
        const paddingTop = parseFloat(cs.paddingTop) || 0;
        const marks = Array.from(gutter.querySelectorAll(".author-gutter-mark")).map((el) => {
          const style = el.style;
          return {
            top: parseFloat(style.top) || 0,
            height: parseFloat(style.height) || 0,
            color: style.getPropertyValue("--peer-color") || style.background || "",
            name: el.dataset.peerName || "",
          };
        });
        return {
          marks,
          metrics: {
            lineHeight,
            paddingTop,
            scrollTop: ta.scrollTop || 0
          }
        };
      })();
    `,
    "getGutterMarks"
  );
}

function computeGaps(marks) {
  if (!Array.isArray(marks) || marks.length < 2) return [];
  const sorted = [...marks].sort((a, b) => a.top - b.top);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prevEnd = sorted[i - 1].top + sorted[i - 1].height;
    const gap = sorted[i].top - prevEnd;
    if (gap > 2) gaps.push(Math.round(gap));
  }
  return gaps;
}

function distinctNames(marks) {
  return Array.from(
    new Set(
      (marks || [])
        .map((m) => (m.name || "").trim())
        .filter(Boolean)
    )
  );
}

function distinctAuthorTokens(marks) {
  return Array.from(
    new Set(
      (marks || [])
        .map((m) => `${(m.color || "").trim()}|${(m.name || "").trim()}`)
        .filter((token) => token.split("|")[0])
    )
  );
}

function computeLineOwners(text, marks, metrics) {
  const content = typeof text === "string" ? text : "";
  const lineCount = (content.match(/\n/g) || []).length + 1;
  const sorted = [...(marks || [])].sort((a, b) => a.top - b.top);
  const lineHeight = Number(metrics?.lineHeight) || 20;
  const paddingTop = Number(metrics?.paddingTop) || 0;
  const scrollTop = Number(metrics?.scrollTop) || 0;

  const owners = [];
  for (let line = 1; line <= lineCount; line += 1) {
    const yCenter = paddingTop - scrollTop + ((line - 1) * lineHeight) + (lineHeight / 2);
    const mark = sorted.find((m) => yCenter >= m.top && yCenter <= (m.top + m.height));
    owners.push({
      line,
      text: (content.split("\n")[line - 1] ?? ""),
      name: mark?.name || null,
      color: mark?.color || null,
      token: mark ? `${mark.color || ""}|${mark.name || ""}` : null
    });
  }
  return owners;
}

async function captureScreenshot(win, screenshotDir, name) {
  try {
    const image = await win.webContents.capturePage();
    const target = path.join(screenshotDir, name);
    await fs.writeFile(target, image.toPNG());
    return target;
  } catch {
    return null;
  }
}

async function waitForConvergence(windows, expectedText) {
  const started = Date.now();
  while (Date.now() - started < CONVERGENCE_TIMEOUT_MS) {
    const texts = await Promise.all(windows.map((w) => getText(w)));
    const normalized = texts.map((v) => (typeof v === "string" ? v.trim() : ""));
    if (normalized.every((t) => t === expectedText.trim())) {
      return { converged: true, texts };
    }
    await sleep(800);
  }
  const texts = await Promise.all(windows.map((w) => getText(w)));
  return { converged: false, texts };
}

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-web-security");

if (USER_DATA_ROOT) {
  app.setPath("userData", path.resolve(USER_DATA_ROOT));
}

app.whenReady().then(async () => {
  const screenshotDir = path.join(USER_DATA_ROOT, "screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });

  const windows = [];

  try {
    console.log("[harness] Opening peer windows...");

    const w1 = await openPeerWindow(PEERS[0], 0);
    windows.push(w1);
    await sleep(1_200);

    const w2 = await openPeerWindow(PEERS[1], 1);
    windows.push(w2);
    await sleep(1_000);

    const w3 = await openPeerWindow(PEERS[2], 2);
    windows.push(w3);
    await sleep(1_500);

    console.log("[harness] person1 paste");
    await pasteBlock(w1, PERSON1_BLOCK, false);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person2 paste");
    await pasteBlock(w2, PERSON2_BLOCK, false);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person3 paste (prepend)");
    await pasteBlock(w3, PERSON3_BLOCK, true);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person1 top line");
    await insertTopLineAtIndex(w1, TOP_LINE_1, 0, false);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person2 top line");
    await insertTopLineAtIndex(w2, TOP_LINE_2, 1, false);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person3 top line");
    await insertTopLineAtIndex(w3, TOP_LINE_3, 2, true);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person1 delete top line");
    await deleteLineAtIndex(w1, 0);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person3 add 6 blank lines after person3 block");
    await insertBlankLinesAfterPerson3Block(w3, PERSON3_EXTRA_BLANK_COUNT);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person2 remove 6 blank lines after person3 block");
    await removeBlankLinesAfterPerson3Block(w2, PERSON3_EXTRA_BLANK_COUNT);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person3 add 6 trailing spaces on top line 3");
    await addTrailingSpacesToTopLine3(w3, TRAILING_SPACES_COUNT);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] person2 remove trailing spaces on top line 3");
    await removeTrailingSpacesFromTopLine3(w2);
    await sleep(BETWEEN_PASTE_MS);

    console.log("[harness] waiting for convergence");
    const { converged, texts } = await waitForConvergence(windows, EXPECTED_FINAL_TEXT);

    await sleep(2_000);

    const instances = [];
    for (let i = 0; i < windows.length; i += 1) {
      const peer = PEERS[i];
      const win = windows[i];
      const rawText = typeof texts[i] === "string" ? texts[i] : await getText(win);
      const gutter = await getGutterMarks(win);
      const marks = Array.isArray(gutter?.marks) ? gutter.marks : [];
      const metrics = gutter?.metrics || null;
      const names = distinctNames(marks);
      const tokens = distinctAuthorTokens(marks);
      const lineOwners = computeLineOwners(rawText, marks, metrics);

      const screenshotPath = await captureScreenshot(win, screenshotDir, `${peer.name}.png`);

      instances.push({
        name: peer.name,
        role: peer.role,
        text: typeof rawText === "string" ? rawText : "",
        converged: typeof rawText === "string" && rawText.trim() === EXPECTED_FINAL_TEXT.trim(),
        markCount: marks.length,
        marks,
        metrics,
        lineOwners,
        distinctAuthorNames: names,
        distinctAuthorTokens: tokens,
        distinctAuthors: tokens.length,
        gutterGaps: computeGaps(marks),
        screenshotPath,
      });
    }

    emitResult({ ok: true, converged, expectedFinalText: EXPECTED_FINAL_TEXT, instances });
    app.exit(0);
  } catch (error) {
    const instances = [];
    for (let i = 0; i < windows.length; i += 1) {
      const peer = PEERS[i];
      const win = windows[i];
      const text = await getText(win).catch(() => "");
      const gutter = await getGutterMarks(win).catch(() => ({ marks: [] }));
      const marks = Array.isArray(gutter?.marks) ? gutter.marks : [];
      const metrics = gutter?.metrics || null;
      const screenshotPath = await captureScreenshot(win, screenshotDir, `${peer.name}-error.png`).catch(() => null);
      instances.push({
        name: peer.name,
        role: peer.role,
        text: typeof text === "string" ? text : "",
        markCount: marks.length,
        marks,
        metrics,
        lineOwners: computeLineOwners(text, marks, metrics),
        distinctAuthorNames: distinctNames(marks),
        distinctAuthorTokens: distinctAuthorTokens(marks),
        distinctAuthors: distinctAuthorTokens(marks).length,
        gutterGaps: computeGaps(marks),
        screenshotPath,
      });
    }

    emitResult({ ok: false, error: String(error?.message || error), instances });
    app.exit(1);
  } finally {
    for (const win of windows) {
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {
      }
    }
  }
});
