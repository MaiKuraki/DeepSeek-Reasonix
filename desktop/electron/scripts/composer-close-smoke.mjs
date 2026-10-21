// Native window close + the real renderer and Go store, using disposable data.
// Build frontend, service and shell first; no provider or clipboard is used.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "reasonix-composer-close-"));
writeFileSync(join(home, "config.toml"), "");
const report = { home, platform: process.platform, checks: [] };
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const rpc = (page, name, ...args) => page.evaluate(({ name, args }) => window.reasonixDesktop.invoke(name, args), { name, args });
const inputSelector = "textarea.composer__input:not([aria-hidden=true])";
let shell;
async function launch() {
  shell = await _electron.launch({ args: [root, `--user-data-dir=${join(home, "electron")}`], env: {
    ...process.env, REASONIX_HOME: home, REASONIX_STATE_HOME: home, REASONIX_CACHE_HOME: join(home, "cache"),
    REASONIX_DEV: "1", REASONIX_DESKTOP_SERVICE: resolve(root, "../build/bin/reasonix-desktop-service" + (process.platform === "win32" ? ".exe" : "")),
  }, timeout: 60000 });
  const page = await shell.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForURL("reasonix://app/index.html", { timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__reasonixFlushSessionDraft) && !document.querySelector(".boot-shell"));
  await page.addLocatorHandler(page.locator(".management-screen__back:visible"), button => button.click());
  await page.locator(".sidebar__quick-action:visible").first().click({ trial: true });
  return page;
}
async function closeWindow() {
  const page = await shell.firstWindow();
  const closed = page.waitForEvent("close", { timeout: 30000 });
  // BrowserWindow.close dispatches the same native close event as the titlebar.
  await shell.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(win => win.isVisible())?.close(); });
  await closed;
  // Native shutdown must destroy the window first. Only then detach
  // Playwright's Node inspector, which otherwise keeps Electron alive at exit.
  await shell.close();
  shell = undefined;
}
async function composer(page) {
  const input = page.locator(inputSelector);
  await input.waitFor();
  await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, inputSelector);
  return input;
}

try {
  let page = await launch();
  await rpc(page, "SetCloseBehavior", "background");
  await shell.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
    const win = BrowserWindow.getAllWindows().find(win => win.isVisible());
    if (!win) return reject(new Error("No visible main window"));
    const timer = setTimeout(() => reject(new Error("Window did not hide after close")), 30000);
    win.once("hide", () => { clearTimeout(timer); resolve(); });
    win.close();
  }));
  check("empty welcome closes to background without a save error");
  await shell.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); });
  // Exercise full shutdown and disk recovery independently of the hide preference.
  await rpc(page, "SetCloseBehavior", "quit");
  await closeWindow();
  check("empty welcome closes through the native window event");

  page = await launch();
  await page.locator(".sidebar__quick-action:visible").first().click();
  let input = await composer(page);
  assert.equal(await input.inputValue(), "");
  await closeWindow();
  check("an empty formal session closes without a save error");

  page = await launch();
  input = await composer(page);
  const tab = (await rpc(page, "ListTabs")).find(item => item.active);
  assert.ok(tab?.sessionId);
  const ref = { hostId: "local", sessionId: tab.sessionId };
  const text = "Keep the latest unsent draft 中文";
  await input.fill(text);
  // Do not wait for the 250 ms autosave or invoke the renderer flush manually.
  await closeWindow();
  page = await launch();
  input = await composer(page);
  assert.equal(await input.inputValue(), text);
  assert.equal(JSON.parse((await rpc(page, "GetSessionComposerState", ref)).contentJson).text, text);
  check("immediate native close saves the latest text and restores it after restart");

  const external = join(home, "external.txt");
  writeFileSync(external, "disposable external file reference");
  await page.locator(".composer-content-file-input").setInputFiles(external);
  await page.waitForFunction(async ref => {
    const state = await window.reasonixDesktop.invoke("GetSessionComposerState", [ref]);
    return JSON.parse(state.contentJson).workspaceRefs?.some(item => item.path.endsWith("external.txt"));
  }, ref);
  const content = JSON.parse((await rpc(page, "GetSessionComposerState", ref)).contentJson);
  await closeWindow();
  page = await launch();
  await composer(page);
  assert.deepEqual(JSON.parse((await rpc(page, "GetSessionComposerState", ref)).contentJson), content);
  await page.locator(".composer-context__item").first().waitFor();
  await closeWindow();
  check("external references survive restart and another normal close without losing saved input");
} catch (error) {
  report.error = String(error);
  if (shell) {
    const page = shell.windows()[0];
    if (page && !page.isClosed()) writeFileSync(join(home, "failure.txt"), await page.locator("body").innerText().catch(() => "renderer unavailable"));
  }
  throw error;
} finally {
  // Only terminate this isolated fixture after a failed normal-close check.
  if (shell) { shell.process().kill("SIGKILL"); }
  writeFileSync(join(home, "results.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${join(home, "results.json")}`);
}
