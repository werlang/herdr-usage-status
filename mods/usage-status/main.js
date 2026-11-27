import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, appHome, notify } from "herdr";
import * as fs from "fs/promises";

// Claude moves fastest (5-hour window), Copilot changes per request, and
// OpenCode Go is a monthly allowance. Poll each at its own pace.
const POLL = { claude: 300_000, antigravity: 600_000, codex: 120_000, copilot: 300_000, opencode: 120_000 };
const STALE = { claude: 10 * 60_000, antigravity: 20 * 60_000, codex: 10 * 60_000, copilot: 15 * 60_000, opencode: 10 * 60_000 };
/** How often the Mods button checks herdr.dev for mod updates (mod-manager does it on open too). */
const DAY_MS = 24 * 60 * 60 * 1000;

const HELPERS = {
  claude: ["python3", "usage.py", "Claude"],
  antigravity: ["python3", "antigravity-usage.py", "Antigravity"],
  codex: ["python3", "codex-usage.py", "Codex"],
  copilot: ["node", "copilot-usage.mjs", "Copilot"],
};

function clamp(value, min, max) {
  const number = Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, number));
}

function usageColor(t, percent) {
  return percent >= 90 ? t.blocked : percent >= 70 ? t.working : t.done;
}

function usageTextColor(t, percent) {
  return percent >= 90 ? t.blocked : percent >= 70 ? t.working : t.muted;
}

/** A compact "2d 8h" countdown for an ISO timestamp or a Unix-millisecond one. */
function resetLabel(value) {
  const stamp = typeof value === "number" ? value : Date.parse(value);
  const left = stamp - Date.now();
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return "now";
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

/** Say how old cached numbers are, short enough for the 28 px bar. */
function ageLabel(age) {
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "stale";
  if (minutes < 60) return `stale ${minutes}m`;
  return `stale ${Math.floor(minutes / 60)}h`;
}

const peakOf = (...values) => Math.max(...values.filter(Number.isFinite), 0);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Dec 12, 18:58" in local time, without relying on Intl. */
function dateLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Readable name for a banked reset's `reset_type`. */
function resetTypeLabel(type) {
  if (type === "codex_rate_limits") return "Codex rate limits";
  return String(type ?? "unknown").replace(/_/g, " ");
}

/** What a consume outcome means, as a toast. */
const RESET_OUTCOMES = {
  reset: { level: "success", text: "Codex limits reset" },
  nothingToReset: { level: "info", text: "Nothing to reset: no Codex window is eligible right now. The reset was kept." },
  noCredit: { level: "warning", text: "That reset is no longer available" },
  alreadyRedeemed: { level: "info", text: "That reset was already redeemed" },
};

export default class UsageStatus extends View {
  init(_props, cx) {
    this.detailsOpen = false;
    // Banked Codex resets, inside the usage panel: whether the cards are
    // expanded, which credit awaits confirmation, which is being redeemed,
    // and the last outcome shown above the cards.
    this.resetsExpanded = false;
    this.resetConfirm = null;
    this.resetBusy = null;
    this.resetMessage = null;
    this.providers = Object.fromEntries(
      Object.keys(POLL).map((name) => [
        name,
        { data: null, at: 0, error: null, warning: null, loading: false, startedAt: 0, generation: 0 },
      ])
    );
    for (const name of Object.keys(POLL)) {
      this.refresh(name, cx);
      cx.timer.every(POLL[name], (cx) => this.refresh(name, cx));
    }
    // The reset countdown and the stale labels age even when a fetch fails.
    cx.timer.every(30_000, (cx) => cx.notify());
    // The Mods button shows only while the optional mod-manager mod
    // (herdr-mod-manager repo) is installed; rechecked so a sync or an
    // uninstall shows up without reloading the bar.
    this.hasModManager = false;
    this.modUpdates = 0;
    this.checkModManager(cx);
    cx.timer.every(15_000, (cx) => this.checkModManager(cx));
  }

  /**
   * Detects the optional mod-manager mod and redraws when that changes.
   * @param {import("gpui-kit").AsyncContext} cx
   */
  checkModManager(cx) {
    cx.spawn(async (cx) => {
      const has = await fs.exists(`${appHome()}/mods/mod-manager/main.js`).catch(() => false);
      const updates = has ? await this.readModUpdates() : null;
      const count = updates?.count ?? 0;
      if (has !== this.hasModManager || count !== this.modUpdates) {
        this.hasModManager = has;
        this.modUpdates = count;
        cx.notify();
      }
      // Once a day, even while the Mods screen stays closed, look for updates
      // to mods installed from herdr.dev (retrying at most hourly when offline).
      const checkedAt = Date.parse(updates?.checkedAt ?? "") || 0;
      if (has && Date.now() - checkedAt >= DAY_MS && Date.now() - (this.modCheckTriedAt ?? 0) >= 3_600_000) {
        this.modCheckTriedAt = Date.now();
        await this.checkModUpdates().catch(() => null);
        this.modUpdates = (await this.readModUpdates())?.count ?? 0;
        cx.notify();
      }
    });
  }

  /** mod-manager's last update check: `{ checkedAt, count, names }`, or null. */
  async readModUpdates() {
    try {
      return JSON.parse(await fs.readFile(`${appHome()}/mods-disabled/.mod-manager-updates.json`, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * The daily check mod-manager would do on open: fetch the herdr.dev mods
   * index and count installed mods whose published folder changed. The index
   * only has each repo's latest commit, which moves for any change, so a
   * moved commit is looked up on GitHub (one call per listing) and compared
   * by the folder's git tree hash. Writes the count, and the index so the
   * Mods screen opens with it; mod-manager owns the sources file.
   */
  async checkModUpdates() {
    const park = `${appHome()}/mods-disabled`;
    const res = await fetch("https://assets.herdr.dev/mods/index.json");
    if (!res.ok) return;
    const index = await res.json();
    if (!Array.isArray(index?.mods)) return;
    const listings = new Map(index.mods.filter((e) => e && typeof e.fullName === "string" && typeof e.path === "string")
      .map((e) => [`${e.fullName}/${e.path.replace(/\/+$/, "")}`.toLowerCase(), e]));
    let sources = {};
    try {
      sources = JSON.parse(await fs.readFile(`${park}/.mod-manager-sources.json`, "utf8"));
    } catch {}
    const trees = new Map(); // listing key -> { folder: tree hash } at its latest commit
    const names = [];
    for (const [name, source] of Object.entries(sources ?? {})) {
      const entry = listings.get(source?.key);
      if (!entry || !entry.modNames?.includes(source.modName) || entry.headCommit === source.commit) continue;
      if (!(await fs.exists(`${appHome()}/mods/${name}`).catch(() => false))) continue;
      let remote = source.remoteCommit === entry.headCommit ? source.remoteTree : undefined;
      if (remote === undefined) {
        if (!trees.has(source.key)) {
          const path = entry.path.replace(/\/+$/, "");
          const r = await fetch(`https://api.github.com/repos/${entry.fullName}/contents/${path ? `${path}/` : ""}mods?ref=${entry.headCommit}`, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "herdr-mod-manager" },
          }).catch(() => null);
          if (!r?.ok) continue; // offline or rate-limited: no badge rather than a wrong one
          const list = await r.json().catch(() => []);
          trees.set(source.key, Object.fromEntries((Array.isArray(list) ? list : []).filter((i) => i?.type === "dir").map((i) => [i.name, i.sha])));
        }
        remote = trees.get(source.key)[source.modName] ?? null;
      }
      if (remote && remote !== source.tree) names.push(name);
    }
    const fetchedAt = Date.now();
    await fs.mkdir(`${park}/.mod-manager-cache`, { recursive: true });
    await fs.writeFile(`${park}/.mod-manager-cache/index.json`, JSON.stringify({ fetchedAt, index }));
    await fs.writeFile(`${park}/.mod-manager-updates.json`, `${JSON.stringify({ checkedAt: new Date(fetchedAt).toISOString(), count: names.length, names: names.sort() }, null, 2)}\n`);
  }

  /** Status-bar button that opens the Mods screen (mod-manager), with its bound key in the tooltip. */
  modsButton(t) {
    if (!this.hasModManager) return null;
    const key = this.keyLabel("mod.open:mod-manager");
    const n = this.modUpdates ?? 0;
    const label = n ? `Mods · ${n} update${n === 1 ? "" : "s"}` : "Mods";
    return h_flex().id("mods-button").px(2).py(2).gap(3).rounded(4).items_center().cursor_pointer().hover((el) => el.bg(t.hover))
      .tooltip(key ? `${label}  ${key}` : label)
      .on_click(() => run("mod.open", { name: "mod-manager" }))
      .child(svg("mods/usage-status/puzzle.svg").size(13).flex_none().text_color(n ? t.accent : t.muted))
      .when(n > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.accent).child(String(n))));
  }

  /**
   * Run a standalone usage helper script and parse its JSON output.
   * @param {string} interpreter - Executable name ("python3" or "node").
   * @param {string} scriptName - Script filename inside the mod directory.
   * @param {string} label - Human-readable provider label for error messages.
   * @returns {Promise<object>} Parsed helper output.
   */
  async runHelper(interpreter, scriptName, label) {
    const result = await exec(interpreter, [`${appHome()}/mods/usage-status/${scriptName}`]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${label} helper exited ${result.code}`);
    const data = JSON.parse(result.stdout);
    if (!data.ok) throw new Error(data.error || `${label} usage request failed`);
    return data;
  }

  /**
   * Query the local OpenCode daemon for Go limit usage.
   * @returns {Promise<object>} Usage data payload.
   */
  async fetchOpencode() {
    const result = await exec("opencode", ["api", "GET", "/api/experimental/usage/limits"]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `OpenCode helper exited ${result.code}`);
    const body = JSON.parse(result.stdout);
    if (!body?.data?.go) throw new Error("OpenCode Go is not signed in");
    return body.data;
  }

  /**
   * Fetch current usage limits for a provider, managing timeouts and concurrency.
   * @param {string} name - Provider identifier in POLL.
   * @param {import("gpui-kit").AsyncContext} cx - Context for scheduling and state notification.
   */
  refresh(name, cx) {
    const provider = this.providers[name];
    if (provider.loading) {
      if (Date.now() - provider.startedAt < 60_000) return;
      provider.error = "Refresh timed out";
    }
    const gen = ++provider.generation;
    provider.loading = true;
    provider.startedAt = Date.now();

    cx.timer.after(60_000, (cx) => {
      if (provider.loading && provider.generation === gen) {
        provider.loading = false;
        provider.error = "Refresh timed out";
        cx.notify();
      }
    });

    const helper = HELPERS[name];
    const load = helper ? () => this.runHelper(...helper) : () => this.fetchOpencode();
    cx.spawn(async (cx) => {
      try {
        const data = await load();
        if (provider.generation !== gen) return;
        provider.data = data;
        provider.at = data.fetched_at ? data.fetched_at * 1000 : Date.now();
        provider.error = null;
        provider.warning = data.warning ?? null;
      } catch (error) {
        if (provider.generation !== gen) return;
        provider.error = String(error?.message ?? error);
      } finally {
        if (provider.generation === gen) {
          provider.loading = false;
          cx.notify();
        }
      }
    });
  }

  /** Re-run every provider that is not already fetching, then redraw the spinner. */
  refreshAll(cx) {
    for (const name of Object.keys(POLL)) this.refresh(name, cx);
    cx.notify();
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const key = this.keyLabel("app.palette");
    return key ? `${key}  commands` : "commands";
  }

  /**
   * The global key bound to an action, as the platform writes it (⇧⌘P), or null.
   * @param {string} action e.g. "app.palette" or "mod.open:mod-manager"
   */
  keyLabel(action) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === action);
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    return parts ? parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
  }

  /** The highest used percentage across every provider that has data. */
  peakUsage() {
    const p = this.providers;
    const peaks = [];
    if (p.claude.data) peaks.push(peakOf(p.claude.data.five_hour?.utilization, p.claude.data.seven_day?.utilization));
    if (p.antigravity.data) peaks.push(peakOf(p.antigravity.data.five_hour?.utilization, p.antigravity.data.seven_day?.utilization));
    if (p.codex.data) peaks.push(peakOf(p.codex.data.five_hour?.utilization, p.codex.data.seven_day?.utilization));
    if (p.copilot.data?.premium) {
      const quota = p.copilot.data.premium;
      peaks.push(quota.unlimited ? 0 : 100 - quota.remaining);
    }
    if (p.opencode.data?.go) {
      const go = p.opencode.data.go;
      peaks.push(peakOf(go.rolling?.percent, go.weekly?.percent, go.monthly?.percent));
    }
    return peaks.length ? Math.max(...peaks) : null;
  }

  /** A one-line hover summary; the full details are behind the click. */
  usageSummary() {
    const p = this.providers;
    const parts = [];
    if (p.claude.data) parts.push(`Claude ${Math.round(peakOf(p.claude.data.five_hour?.utilization, p.claude.data.seven_day?.utilization))}%`);
    if (p.antigravity.data) parts.push(`Antigravity ${Math.round(peakOf(p.antigravity.data.five_hour?.utilization, p.antigravity.data.seven_day?.utilization))}%`);
    if (p.codex.data) parts.push(`Codex ${Math.round(peakOf(p.codex.data.five_hour?.utilization, p.codex.data.seven_day?.utilization))}%`);
    if (p.copilot.data?.premium && !p.copilot.data.premium.unlimited) {
      parts.push(`Copilot ${Math.round(100 - p.copilot.data.premium.remaining)}%`);
    }
    if (p.opencode.data?.go) {
      const go = p.opencode.data.go;
      parts.push(`OpenCode ${Math.round(peakOf(go.rolling?.percent, go.weekly?.percent, go.monthly?.percent))}%`);
    }
    return parts.length ? `Usage limits · ${parts.join(" · ")}` : "Usage limits";
  }

  /** Whether any provider is fetching right now. */
  isLoading() {
    return Object.values(this.providers).some((provider) => provider.loading);
  }

  /** The single status-bar control: one gauge, colored by the fullest provider. */
  usageButton(t) {
    const peak = this.peakUsage();
    if (peak === null && !this.isLoading()) return null;
    const color = peak === null ? t.dim : peak >= 90 ? t.blocked : peak >= 70 ? t.working : t.muted;
    return h_flex().id("usage-meter").px(2).py(2).rounded(4).items_center().cursor_pointer().hover((el) => el.bg(t.hover))
      .tooltip(this.usageSummary())
      .child(svg("mods/usage-status/gauge.svg").size(14).flex_none().text_color(color));
  }

  /** Panel-header control that re-runs every provider and spins until the fetches settle. */
  refreshButton(t) {
    const loading = this.isLoading();
    return h_flex().id("usage-refresh").p(3).rounded(4).items_center().cursor_pointer().hover((el) => el.bg(t.hover))
      .tooltip(loading ? "Refreshing usage…" : "Refresh usage")
      .accessibility_label(loading ? "Refreshing usage limits" : "Refresh usage limits")
      .role("button")
      .on_click((_event, cx) => this.refreshAll(cx))
      .child(svg("mods/usage-status/refresh.svg").size(13).flex_none().text_color(loading ? t.working : t.muted)
        .when(loading, (el) => el.spin(900)));
  }

  /** One labelled bar inside the details panel, with the reset on the same line. */
  detailsRow(t, label, percentValue, note) {
    const percent = Math.round(clamp(percentValue ?? 0, 0, 100));
    return h_flex().gap(8).items_center()
      .child(div().w(58).text_color(t.muted).child(label))
      .child(h_flex().w(62).h(4).rounded(2).bg(t.border).overflow_hidden().flex_none()
        .child(div().h_full().w(`${percent}%`).bg(usageColor(t, percent))))
      .child(div().w(34).text_color(usageTextColor(t, percent)).child(`${percent}%`))
      .when(Boolean(note), el => el.child(div().flex_1().truncate().text_size(10.5).text_color(t.dim).child(note)));
  }

  /** A provider heading followed by its window rows. */
  detailsSection(t, icon, tint, title, status, rows, fullColor = false, badge = null) {
    const picture = fullColor
      ? image(icon).w(13).h(13).flex_none()
      : svg(icon).size(13).flex_none().text_color(tint);
    return v_flex().gap(3)
      .child(h_flex().gap(6).items_center()
        .child(picture)
        .child(div().text_size(11.5).text_color(t.foreground).child(title))
        .when(Boolean(badge), (el) => el.child(badge))
        .child(div().flex_1())
        .child(div().max_w(190).truncate().text_size(10).text_color(t.dim).child(status)))
      .children(rows);
  }

  resetNote(limit) {
    const reset = resetLabel(limit?.resets_at);
    return reset ? `resets in ${reset}` : null;
  }

  /**
   * Build the compact status line used across provider detail sections.
   * @param {object} provider - Provider state with data, at, error, warning.
   * @param {number} staleMs - Milliseconds before data is marked stale.
   * @param {string|null} [extra] - Provider-specific prefix tag (e.g. bucket name or plan).
   * @returns {string} Formatted status line (e.g. "live", "stale 5m", "refresh failed").
   */
  statusLine(provider, staleMs, extra) {
    const age = Date.now() - provider.at;
    const stale = age > staleMs;
    return [
      extra,
      stale ? ageLabel(age) : null,
      provider.warning || provider.error ? "refresh failed" : null,
    ].filter(Boolean).join(" · ") || "live";
  }

  claudeDetails(t) {
    const provider = this.providers.claude;
    if (!provider.data) return null;
    const usage = provider.data;
    const status = this.statusLine(provider, STALE.claude, usage.cached ? "cached" : null);
    const rows = [];
    if (usage.five_hour) rows.push(this.detailsRow(t, "5-hour", usage.five_hour.utilization, this.resetNote(usage.five_hour)));
    if (usage.seven_day) rows.push(this.detailsRow(t, "7-day", usage.seven_day.utilization, this.resetNote(usage.seven_day)));
    return rows.length ? this.detailsSection(t, "icons/claude.svg", "#D97757", "Claude", status, rows) : null;
  }

  /** Shorten an Antigravity group name for the compact panel. */
  antigravityGroup(name) {
    const lower = name.toLowerCase();
    if (lower.includes("claude") && lower.includes("gpt")) return "Claude/GPT";
    if (lower.includes("argon")) return "Argon";
    if (lower.includes("gemini")) return "Gemini";
    return name;
  }

  antigravityDetails(t) {
    const provider = this.providers.antigravity;
    if (!provider.data) return null;
    const usage = provider.data;
    const status = this.statusLine(provider, STALE.antigravity, usage.bucket);
    const note = (window) => [
      window.remaining != null ? `${Math.round(window.remaining)}% left` : null,
      this.resetNote(window),
    ].filter(Boolean).join(" · ");
    const rows = [];
    for (const [label, window] of [["5-hour", usage.five_hour], ["7-day", usage.seven_day]]) {
      if (window) rows.push(this.detailsRow(t, label, window.utilization, note(window)));
    }
    for (const bucket of usage.buckets ?? []) {
      const entries = [];
      if (bucket.five_hour) entries.push(["5-hour", bucket.five_hour]);
      if (bucket.seven_day) entries.push([bucket.five_hour ? "7-day" : "Weekly", bucket.seven_day]);
      if (!entries.length) continue;
      rows.push(div().pt(3).text_size(10).text_color(t.dim).font_semibold().child(this.antigravityGroup(bucket.name)));
      for (const [label, window] of entries) {
        rows.push(this.detailsRow(t, label, window.utilization, note(window)));
      }
    }
    return rows.length ? this.detailsSection(t, "icons/antigravity.svg", t.muted, "Antigravity", status, rows, true) : null;
  }

  codexDetails(t) {
    const provider = this.providers.codex;
    if (!provider.data) return null;
    const usage = provider.data;
    const status = this.statusLine(provider, STALE.codex, usage.plan ? `Codex ${usage.plan}` : null);
    const rows = [];
    if (usage.five_hour) rows.push(this.detailsRow(t, "5-hour", usage.five_hour.utilization, this.resetNote(usage.five_hour)));
    if (usage.seven_day) rows.push(this.detailsRow(t, "7-day", usage.seven_day.utilization, this.resetNote(usage.seven_day)));
    if (!rows.length) return null;
    if (this.resetsExpanded) rows.push(this.resetsList(t));
    return this.detailsSection(t, "mods/usage-status/codex.svg", t.muted, "Codex", status, rows, false, this.resetsBadge(t));
  }

  /** Codex's banked resets that can still be redeemed, soonest to expire first. */
  codexResets() {
    const credits = this.providers.codex.data?.reset_credits?.credits ?? [];
    return credits
      .filter((credit) => credit.status === "available")
      .sort((a, b) => (Date.parse(a.expires_at) || Infinity) - (Date.parse(b.expires_at) || Infinity));
  }

  /** Whether a Codex window is maxed out, so a reset would unblock work now. */
  codexMaxed() {
    const usage = this.providers.codex.data;
    if (!usage) return false;
    return Boolean(usage.limit_reached) || peakOf(usage.five_hour?.utilization, usage.seven_day?.utilization) >= 100;
  }

  /**
   * Badge beside the Codex heading in the usage panel: banked-reset count,
   * accent-colored while a limit is maxed out. Clicking it shows or hides
   * the reset cards under the Codex windows.
   */
  resetsBadge(t) {
    const count = this.providers.codex.data?.reset_credits?.available ?? 0;
    if (count <= 0) return null;
    const maxed = this.codexMaxed();
    const open = this.resetsExpanded;
    const label = `${count} reset${count === 1 ? "" : "s"} banked${maxed ? " · limit reached" : ""}`;
    const color = maxed ? t.accent : t.muted;
    return h_flex().id("codex-resets-badge").px(5).py(1).gap(3).rounded(8).items_center().cursor_pointer()
      .border_1().border_color(open ? color : t.border)
      .bg(open ? t.hover : t.popover)
      .hover((el) => el.bg(t.hover))
      .tooltip(open ? `${label} · hide` : `${label} · show details`)
      .accessibility_label(label)
      .role("button")
      .on_click((_event, cx) => {
        this.resetsExpanded = !this.resetsExpanded;
        if (!this.resetsExpanded) this.resetConfirm = null;
        cx.notify();
      })
      .child(svg("mods/usage-status/reset.svg").size(10).flex_none().text_color(color))
      .child(div().flex_none().text_size(10).text_color(color).child(`${count} reset${count === 1 ? "" : "s"}`));
  }

  /**
   * Redeem one banked reset through the Codex CLI, then refresh Codex.
   * @param {string} id - Reset credit id.
   * @param {import("gpui-kit").AsyncContext} cx
   */
  activateReset(id, cx) {
    if (this.resetBusy) return;
    this.resetBusy = id;
    this.resetConfirm = null;
    this.resetMessage = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let message;
      try {
        const result = await exec("python3", [`${appHome()}/mods/usage-status/codex-reset.py`, id]);
        const data = JSON.parse(result.stdout || "{}");
        if (!data.ok) throw new Error(data.error || "Reset request failed");
        message = RESET_OUTCOMES[data.outcome] ?? { level: "warning", text: `Unexpected outcome: ${data.outcome}` };
      } catch (error) {
        message = { level: "error", text: `Reset failed: ${String(error?.message ?? error)}` };
      }
      this.resetBusy = null;
      this.resetMessage = message;
      notify({ title: "Codex reset", body: message.text, level: message.level, icon: "mods/usage-status/codex.svg" });
      this.refresh("codex", cx);
      cx.notify();
    });
  }

  /** A small text button for the resets popover. */
  resetAction(t, id, text, color, onClick, emphasis = false) {
    return h_flex().id(id).flex_none().px(8).py(2).rounded(4).items_center().cursor_pointer()
      .border_1().border_color(emphasis ? color : t.border)
      .hover((el) => el.bg(t.hover))
      .role("button")
      .on_click(onClick)
      .child(div().text_size(10.5).text_color(color).child(text));
  }

  /**
   * One banked reset, compact: title with its action, then type and grant
   * date, then expiry. The description is the card's tooltip. Confirmation
   * replaces the action with a Cancel/Confirm line.
   */
  resetCard(t, credit, index) {
    const expires = dateLabel(credit.expires_at);
    const left = resetLabel(credit.expires_at);
    const granted = dateLabel(credit.granted_at);
    const soon = Date.parse(credit.expires_at) - Date.now() < 3 * DAY_MS;
    const busy = this.resetBusy === credit.id;
    const confirming = this.resetConfirm === credit.id;
    const unsupported = credit.supported === false;
    const first = index === 0 && this.codexResets().length > 1;

    let action = null;
    if (busy) {
      action = div().flex_none().text_size(10.5).text_color(t.working).child("Activating…");
    } else if (unsupported) {
      action = div().flex_none().text_size(10).text_color(t.dim).child("Not on this plan");
    } else if (!confirming) {
      action = this.resetAction(t, `reset-activate-${index}`, "Activate", this.resetBusy ? t.dim : t.accent, (_e, cx) => {
        if (this.resetBusy) return;
        this.resetConfirm = credit.id;
        this.resetMessage = null;
        cx.notify();
      }, true);
    }

    const meta = [resetTypeLabel(credit.type), granted ? `granted ${granted}` : null].filter(Boolean).join(" · ");
    const expiry = expires ? `Expires ${expires}${left ? ` · in ${left}` : ""}${first ? " · first" : ""}` : null;

    return v_flex().id(`reset-card-${index}`).flex_none().gap(2).px(8).py(6).rounded(6).border_1().border_color(confirming ? t.accent : t.border)
      .when(Boolean(credit.description), (el) => el.tooltip(credit.description))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(credit.title || "Rate limit reset"))
        .when(Boolean(action), (el) => el.child(action)))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(meta))
      .when(Boolean(expiry), (el) => el.child(div().truncate().text_size(10.5).text_color(soon ? t.working : t.muted).child(expiry)))
      .when(confirming, (el) => el.child(h_flex().gap(6).items_center().pt(4)
        .child(div().flex_1().text_size(10).text_color(t.muted).child(this.codexMaxed() ? "Use this reset now?" : "No limit is maxed. Use it anyway?"))
        .child(this.resetAction(t, `reset-cancel-${index}`, "Cancel", t.muted, (_e, cx) => { this.resetConfirm = null; cx.notify(); }))
        .child(this.resetAction(t, `reset-confirm-${index}`, "Confirm", t.accent, (_e, cx) => this.activateReset(credit.id, cx), true))));
  }


  /** The reset cards shown under the Codex windows when the badge is open. */
  resetsList(t) {
    const credits = this.codexResets();
    const banked = this.providers.codex.data?.reset_credits?.available ?? 0;
    const message = this.resetMessage;
    const messageColor = message && { success: t.done, info: t.muted, warning: t.working, error: t.blocked }[message.level];
    return v_flex().gap(6).pt(4).text_size(11)
      .when(Boolean(message), (el) => el.child(div().text_size(10.5).text_color(messageColor).whitespace_normal().child(message.text)))
      .children(credits.length
        ? credits.map((credit, index) => this.resetCard(t, credit, index))
        : [div().text_color(t.dim).child(banked > 0 ? "Details unavailable right now. Refresh to retry." : "No banked resets")]);
  }

  copilotDetails(t) {
    const provider = this.providers.copilot;
    if (!provider.data) return null;
    const quota = provider.data.premium;
    if (!quota) return null;
    const status = this.statusLine(provider, STALE.copilot, quota.unlimited ? "unlimited" : null);
    const rows = quota.unlimited ? [] : [
      this.detailsRow(t, "Premium", 100 - (quota.remaining ?? 100), `${quota.used ?? 0} of ${quota.entitlement ?? 0} used`),
    ];
    return this.detailsSection(t, "icons/copilot.svg", t.muted, "GitHub Copilot", status, rows);
  }

  opencodeDetails(t) {
    const provider = this.providers.opencode;
    if (!provider.data) return null;
    const go = provider.data.go;
    if (!go) return null;
    const limited = [go.rolling, go.weekly, go.monthly].some((window) => window?.limited);
    const status = this.statusLine(provider, STALE.opencode, limited ? "limited" : null);
    const rows = [];
    for (const [label, window] of [["Rolling", go.rolling], ["Weekly", go.weekly], ["Monthly", go.monthly]]) {
      if (!window) continue;
      const reset = resetLabel(window.resetsAt);
      rows.push(this.detailsRow(t, label, window.percent, reset ? `resets in ${reset}` : null));
    }
    return rows.length ? this.detailsSection(t, "icons/opencode.svg", t.muted, "OpenCode Go", status, rows) : null;
  }

  /**
   * The tallest the usage panel can be and still fit in the window above
   * the 28 px status bar. `window` is shadowed by herdr's import, so the
   * GPUI window is read from globalThis.
   */
  panelMaxHeight() {
    try {
      const height = globalThis.window?.viewport_size?.()?.height;
      if (Number.isFinite(height)) return clamp(height - 28 - 24, 160, 900);
    } catch {}
    return 420;
  }

  /**
   * Approximate height of the provider sections, in px, built from the same
   * data the sections render. Only used to decide whether the panel needs a
   * fixed-height scroll area; it errs high so the scroll kicks in early.
   */
  sectionsHeight() {
    const p = this.providers;
    const ROW = 22, HEAD = 22, GAP = 9, LABEL = 18, CARD = 80;
    const heights = [];
    const windows = (d) => [d?.five_hour, d?.seven_day].filter(Boolean).length;
    if (p.claude.data && windows(p.claude.data)) heights.push(HEAD + windows(p.claude.data) * ROW);
    if (p.antigravity.data) {
      const d = p.antigravity.data;
      let h = windows(d) * ROW;
      for (const bucket of d.buckets ?? []) {
        const n = windows(bucket);
        if (n) h += LABEL + n * ROW;
      }
      if (h) heights.push(HEAD + h);
    }
    if (p.codex.data && windows(p.codex.data)) {
      let h = HEAD + windows(p.codex.data) * ROW;
      if (this.resetsExpanded) {
        const cards = Math.max(1, this.codexResets().length);
        h += 4 + cards * (CARD + 6) + (this.resetMessage ? 34 : 0) + (this.resetConfirm ? 30 : 0);
      }
      heights.push(h);
    }
    if (p.copilot.data?.premium) heights.push(HEAD + (p.copilot.data.premium.unlimited ? 0 : ROW));
    if (p.opencode.data?.go) {
      const go = p.opencode.data.go;
      heights.push(HEAD + [go.rolling, go.weekly, go.monthly].filter(Boolean).length * ROW);
    }
    return heights.reduce((sum, h) => sum + h, 0) + Math.max(0, heights.length - 1) * GAP;
  }

  /** The click-to-open surface: only providers with real data, every window. */
  detailsPanel(t) {
    const sections = [
      this.claudeDetails(t),
      this.antigravityDetails(t),
      this.codexDetails(t),
      this.copilotDetails(t),
      this.opencodeDetails(t),
    ].filter(Boolean);
    // The panel grows with its content up to the window's height. Only when
    // the content would not fit does the section list get a fixed height
    // and an always-visible scrollbar: a scroll area here needs a definite
    // height (a max_h alone squeezes and clips its rows instead).
    const scrollMax = this.panelMaxHeight() - 24 - 9 - 24;
    const scrolls = this.sectionsHeight() > scrollMax;
    const body = v_flex().flex_none().px(12).gap(9)
      .children(sections.length ? sections : [div().text_color(t.dim).child("No usage data yet")]);
    return v_flex().w(360).py(12).gap(9)
      .bg(t.popover).border_1().border_color(t.border).rounded(9).shadow_lg()
      .text_size(11.5).text_color(t.muted)
      .child(h_flex().flex_none().px(12).gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(t.foreground).child("Usage limits"))
        .child(div().text_size(10).text_color(t.dim).child("click outside to close"))
        .child(this.refreshButton(t)))
      .child(scrolls
        ? v_flex().id("usage-details-scroll").flex_none().h(scrollMax).overflow_y_scrollbar().mode("always").child(body)
        : body);
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/usage-status/${icon}.svg`).size(13)).child(text);
    const button = this.usageButton(t);
    const usage = button && Popover.new("usage-details")
      .open(this.detailsOpen)
      .on_open_change((open, cx) => {
        this.detailsOpen = open;
        if (!open) this.resetConfirm = null;
        cx.notify();
      })
      .anchor("bottom_left")
      .trigger(button)
      .content(this.detailsPanel(t));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .when(Boolean(this.modsButton(t)), el => el.child(this.modsButton(t)))
      .when(Boolean(usage), el => el.child(usage))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
