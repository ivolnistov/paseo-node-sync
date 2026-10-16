// Synthetic render harness for the plugin's client bundle. It loads a bundle in Paseo's client format
// ((function(require) {...})) with a host `require` that supplies real React/zod/@getpaseo/plugin, React Native
// primitives replaced by plain host elements, and a useRpc backed by a caller-supplied RPC function. It renders with
// react-test-renderer. This proves component logic and RPC wiring; it is NOT the Paseo app and draws no pixels.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const req = createRequire(new URL("../package.json", import.meta.url));
const React = req("react") as typeof import("react");
const TestRenderer = req("react-test-renderer") as { create(el: unknown): Renderer; act: (fn: () => unknown) => Promise<void> };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => unknown) => Promise<void> }).act;

export type RpcCall = (method: string, input: unknown) => Promise<unknown>;
interface Node { type: string; props: Record<string, any>; children: (Node | string)[] | null }
interface Renderer { toJSON(): Node | Node[] | null; unmount(): void; root: { findAll(p: (n: { type: unknown; props: Record<string, any> }) => boolean): { type: unknown; props: Record<string, any> }[] } }

const host = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children as never);
const reactNative = { View: host("View"), Text: host("Text"), Pressable: host("Pressable"), TextInput: host("TextInput"), ScrollView: host("ScrollView") };

export function loadClientBundle(code: string, call: RpcCall) {
  const useRpc = (contract: { name: string; output: { parse(v: unknown): unknown } }) =>
    React.useCallback((input: unknown) => call(contract.name, input).then(o => contract.output.parse(o)), [contract]);
  const modules: Record<string, unknown> = {
    react: React, "react/jsx-runtime": req("react/jsx-runtime"), "react-native": reactNative, zod: req("zod"),
    "@getpaseo/plugin": req("@getpaseo/plugin"), "@getpaseo/plugin/client": { useRpc },
    "@getpaseo/plugin/client/ui": { SidebarRow: host("SidebarRow"), SidebarSeparator: host("SidebarSeparator") },
  };
  const hostRequire = (id: string) => { if (!(id in modules)) throw new Error(`bundle requires an unexpected host module: ${id}`); return modules[id]; };
  const factory = (0, eval)(code) as (r: typeof hostRequire) => { default?: (c: unknown) => unknown } & ((c: unknown) => unknown);
  const exported = factory(hostRequire);
  const contribute = (exported.default ?? exported) as (c: unknown) => () => void;
  const screens: Record<string, { title: string; Component: (p: unknown) => unknown }> = {};
  const sidebar: Record<string, { title: string; Component: (p: unknown) => unknown }> = {};
  const cleanup = contribute({
    addScreen(c: { id: string; title: string; Component: (p: unknown) => unknown }) { screens[c.id] = c; return () => { delete screens[c.id]; }; },
    addSidebarFooterItem(c: { id: string; title: string; Component: (p: unknown) => unknown }) { sidebar[c.id] = c; return () => { delete sidebar[c.id]; }; },
  });
  return { screens, sidebar, cleanup };
}

// Wraps a client entry built by esbuild (format cjs) into Paseo's client bundle shape.
export async function bundleClientEntry(entry: string): Promise<string> {
  const esbuild = req("esbuild") as typeof import("esbuild");
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native", "zod", "@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui"] });
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${out.outputFiles[0]!.text}\nreturn module.exports;\n})`;
}

export const themes = {
  light: { colors: { surface0: "#ffffff", surface1: "#f4f4f5", surface2: "#e4e4e7", border: "#d4d4d8", foreground: "#18181b", foregroundMuted: "#71717a",
    accent: "#2563eb", accentForeground: "#ffffff", statusSuccess: "#16a34a", statusWarning: "#ca8a04", statusDanger: "#dc2626" } },
  dark: { colors: { surface0: "#09090b", surface1: "#18181b", surface2: "#27272a", border: "#3f3f46", foreground: "#fafafa", foregroundMuted: "#a1a1aa",
    accent: "#60a5fa", accentForeground: "#09090b", statusSuccess: "#4ade80", statusWarning: "#facc15", statusDanger: "#f87171" } },
};

export class Screen {
  r!: Renderer;
  static async render(Component: (p: unknown) => unknown, props: Record<string, unknown>): Promise<Screen> {
    const s = new Screen();
    await act(async () => { s.r = TestRenderer.create(React.createElement(Component as never, props as never)); });
    await s.settle();
    return s;
  }
  async settle(ms = 20) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }
  texts(): string[] {
    const out: string[] = [];
    const walk = (n: Node | string | null) => {
      if (n === null) return;
      if (typeof n === "string") { out.push(n); return; }
      if (n.type === "Text") { out.push(flat(n)); return; }
      for (const c of n.children ?? []) walk(c);
    };
    const flat = (n: Node | string): string => typeof n === "string" ? n : (n.children ?? []).map(flat).join("");
    const json = this.r.toJSON();
    for (const n of Array.isArray(json) ? json : [json]) walk(n);
    return out;
  }
  hasText(re: RegExp): boolean { return this.texts().some(t => re.test(t)); }
  find(type: string, label: string | RegExp) {
    const hits = this.r.root.findAll(n => n.type === type && (typeof label === "string" ? n.props.accessibilityLabel === label : label.test(String(n.props.accessibilityLabel ?? ""))));
    if (hits.length === 0) throw new Error(`no ${type} labelled ${String(label)}; texts: ${this.texts().join(" | ").slice(0, 400)}`);
    return hits[0]!;
  }
  styleOf(type: string, label: string): Record<string, unknown> {
    const s = this.find(type, label).props.style;
    return Object.assign({}, ...(Array.isArray(s) ? s : [s]));
  }
  rootStyle(): Record<string, unknown> {
    const json = this.r.toJSON() as Node;
    return Object.assign({}, ...(Array.isArray(json.props.style) ? json.props.style : [json.props.style]));
  }
  async press(label: string | RegExp) { const p = this.find("Pressable", label); await act(async () => { await p.props.onPress(); }); await this.settle(); }
  async type(label: string, value: string) { const t = this.find("TextInput", label); await act(async () => { t.props.onChangeText(value); }); }
  async unmount() { await act(async () => { this.r.unmount(); }); }
}

export async function readBundle(path: string): Promise<string> { return readFile(path, "utf8"); }
