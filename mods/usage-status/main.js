import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, appHome } from "herdr";

// Claude moves fastest (5-hour window), Copilot changes per request, and
// OpenCode Go is a monthly allowance. Poll each at its own pace.
const POLL = { claude: 300_000, antigravity: 600_000, codex: 120_000, copilot: 300_000, opencode: 120_000 };
const STALE = { claude: 5 * 60_000, antigravity: 20 * 60_000, codex: 10 * 60_000, copilot: 15 * 60_000, opencode: 10 * 60_000 };

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

export default class UsageStatus extends View {
  init(_props, cx) {
    this.detailsOpen = false;
    this.providers = {
      claude: { data: null, at: 0, error: null, warning: null, loading: false },
      antigravity: { data: null, at: 0, error: null, warning: null, loading: false },
      codex: { data: null, at: 0, error: null, warning: null, loading: false },
      copilot: { data: null, at: 0, error: null, warning: null, loading: false },
      opencode: { data: null, at: 0, error: null, warning: null, loading: false },
    };
    this.refresh("claude", cx);
    this.refresh("antigravity", cx);
    this.refresh("codex", cx);
    this.refresh("copilot", cx);
    this.refresh("opencode", cx);
    for (const name of Object.keys(POLL)) {
      cx.timer.every(POLL[name], (cx) => this.refresh(name, cx));
    }
    // The reset countdown and the stale labels age even when a fetch fails.
    cx.timer.every(30_000, (cx) => cx.notify());
  }

  async fetchClaude() {
    const result = await exec("python3", [`${appHome()}/mods/usage-status/usage.py`]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Claude helper exited ${result.code}`);
    const data = JSON.parse(result.stdout);
    if (!data.ok) throw new Error(data.error || "Claude usage request failed");
    return data;
  }

  async fetchAntigravity() {
    const result = await exec("python3", [`${appHome()}/mods/usage-status/antigravity-usage.py`]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Antigravity helper exited ${result.code}`);
    const data = JSON.parse(result.stdout);
    if (!data.ok) throw new Error(data.error || "Antigravity usage request failed");
    return data;
  }

  async fetchCodex() {
    const result = await exec("python3", [`${appHome()}/mods/usage-status/codex-usage.py`]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Codex helper exited ${result.code}`);
    const data = JSON.parse(result.stdout);
    if (!data.ok) throw new Error(data.error || "Codex usage request failed");
    return data;
  }

  async fetchCopilot() {
    const result = await exec("node", [`${appHome()}/mods/usage-status/copilot-usage.mjs`]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Copilot helper exited ${result.code}`);
    const data = JSON.parse(result.stdout);
    if (!data.ok) throw new Error(data.error || "Copilot usage request failed");
    return data;
  }

  async fetchOpencode() {
    const result = await exec("opencode", ["api", "GET", "/api/experimental/usage/limits"]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `OpenCode helper exited ${result.code}`);
    const body = JSON.parse(result.stdout);
    if (!body?.data?.go) throw new Error("OpenCode Go is not signed in");
    return body.data;
  }

  refresh(name, cx) {
    const provider = this.providers[name];
    if (provider.loading) return;
    provider.loading = true;
    const load = name === "claude" ? () => this.fetchClaude()
      : name === "antigravity" ? () => this.fetchAntigravity()
        : name === "codex" ? () => this.fetchCodex()
          : name === "copilot" ? () => this.fetchCopilot()
            : () => this.fetchOpencode();
    cx.spawn(async (cx) => {
      try {
        const data = await load();
        provider.data = data;
        provider.at = data.fetched_at ? data.fetched_at * 1000 : Date.now();
        provider.error = null;
        provider.warning = data.warning ?? null;
      } catch (error) {
        provider.error = String(error?.message ?? error);
      } finally {
        provider.loading = false;
        cx.notify();
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
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

  /** The single status-bar control: one gauge, colored by the fullest provider. */
  usageButton(t) {
    const peak = this.peakUsage();
    const loading = Object.values(this.providers).some((provider) => provider.loading);
    if (peak === null && !loading) return null;
    const color = peak === null ? t.dim : peak >= 90 ? t.blocked : peak >= 70 ? t.working : t.muted;
    return h_flex().id("usage-meter").px(2).py(2).rounded(4).items_center().cursor_pointer().hover((el) => el.bg(t.hover))
      .tooltip(this.usageSummary())
      .child(svg("mods/usage-status/gauge.svg").size(14).flex_none().text_color(color));
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
  detailsSection(t, icon, tint, title, status, rows, fullColor = false) {
    const picture = fullColor
      ? image(icon).w(13).h(13).flex_none()
      : svg(icon).size(13).flex_none().text_color(tint);
    return v_flex().gap(3)
      .child(h_flex().gap(6).items_center()
        .child(picture)
        .child(div().text_size(11.5).text_color(t.foreground).child(title))
        .child(div().flex_1())
        .child(div().max_w(190).truncate().text_size(10).text_color(t.dim).child(status)))
      .children(rows);
  }

  resetNote(limit) {
    const reset = resetLabel(limit?.resets_at);
    return reset ? `resets in ${reset}` : null;
  }

  claudeDetails(t) {
    const provider = this.providers.claude;
    if (!provider.data) return null;
    const usage = provider.data;
    const age = Date.now() - provider.at;
    const stale = age > STALE.claude;
    const status = [
      usage.cached ? "cached" : null,
      stale ? ageLabel(age) : null,
      provider.warning || provider.error ? "refresh failed" : null,
    ].filter(Boolean).join(" · ") || "live";
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
    const age = Date.now() - provider.at;
    const stale = age > STALE.antigravity;
    const status = [
      usage.bucket,
      stale ? ageLabel(age) : null,
      provider.warning || provider.error ? "refresh failed" : null,
    ].filter(Boolean).join(" · ") || "live";
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
    const age = Date.now() - provider.at;
    const stale = age > STALE.codex;
    const status = [
      usage.plan ? `Codex ${usage.plan}` : null,
      stale ? ageLabel(age) : null,
      provider.warning || provider.error ? "refresh failed" : null,
    ].filter(Boolean).join(" · ") || "live";
    const rows = [];
    if (usage.five_hour) rows.push(this.detailsRow(t, "5-hour", usage.five_hour.utilization, this.resetNote(usage.five_hour)));
    if (usage.seven_day) rows.push(this.detailsRow(t, "7-day", usage.seven_day.utilization, this.resetNote(usage.seven_day)));
    return rows.length ? this.detailsSection(t, "mods/usage-status/codex.svg", t.muted, "Codex", status, rows) : null;
  }

  copilotDetails(t) {
    const provider = this.providers.copilot;
    if (!provider.data) return null;
    const quota = provider.data.premium;
    if (!quota) return null;
    const age = Date.now() - provider.at;
    const stale = age > STALE.copilot;
    const status = [
      quota.unlimited ? "unlimited" : null,
      stale ? ageLabel(age) : null,
      provider.warning || provider.error ? "refresh failed" : null,
    ].filter(Boolean).join(" · ") || "live";
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
    const age = Date.now() - provider.at;
    const stale = age > STALE.opencode;
    const limited = [go.rolling, go.weekly, go.monthly].some((window) => window?.limited);
    const status = [
      limited ? "limited" : null,
      stale ? ageLabel(age) : null,
      provider.warning || provider.error ? "refresh failed" : null,
    ].filter(Boolean).join(" · ") || "live";
    const rows = [];
    for (const [label, window] of [["Rolling", go.rolling], ["Weekly", go.weekly], ["Monthly", go.monthly]]) {
      if (!window) continue;
      const reset = resetLabel(window.resetsAt);
      rows.push(this.detailsRow(t, label, window.percent, reset ? `resets in ${reset}` : null));
    }
    return rows.length ? this.detailsSection(t, "icons/opencode.svg", t.muted, "OpenCode Go", status, rows) : null;
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
    return v_flex().w(360).max_h(600).overflow_y_scrollbar().p(12).gap(9)
      .bg(t.popover).border_1().border_color(t.border).rounded(9).shadow_lg()
      .text_size(11.5).text_color(t.muted)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(12).text_color(t.foreground).child("Usage limits"))
        .child(div().text_size(10).text_color(t.dim).child("click outside to close")))
      .children(sections.length ? sections : [div().text_color(t.dim).child("No usage data yet")]);
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const button = this.usageButton(t);
    const usage = button && Popover.new("usage-details")
      .open(this.detailsOpen)
      .on_open_change((open, cx) => { this.detailsOpen = open; cx.notify(); })
      .anchor("bottom_right")
      .trigger(button)
      .content(this.detailsPanel(t));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(usage), el => el.child(usage))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
