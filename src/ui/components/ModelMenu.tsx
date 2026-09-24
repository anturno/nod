/** `/models`: provider tabs → model rows with facts → effort → fast. */
import { Text } from "ink";
import type { Provider } from "../../core/agent/types.ts";
import type { Subscription } from "../../providers/providers.ts";
import type { Surface } from "../core/terminal.ts";
import { C } from "../theme.ts";
import { Menu, Tabs } from "./Menu.tsx";

export function ModelMenu({
  surface,
  subscriptions,
}: {
  surface: Extract<Surface, { kind: "model" }>;
  subscriptions: Record<Provider, Subscription>;
}) {
  const providers = Object.keys(subscriptions) as Provider[];
  if (surface.step === "model") {
    const rows = surface.rows;
    const width = Math.max(0, ...(rows ?? []).map((r) => r.id.length));
    return (
      <Menu
        title={`Models ${rows?.length ?? 0}`}
        tabs={
          <Tabs tabs={providers.map((p) => subscriptions[p].label)} active={subscriptions[surface.provider].label} />
        }
        index={surface.index}
        rows={
          rows?.map((r) => ({
            key: r.id,
            left: r.id.padEnd(width),
            right: <Text color={C.mutedForeground}>{r.facts}</Text>,
            disabled: r.disabled,
          })) ?? null
        }
        empty={surface.error ?? "no models"}
        footer={<Text color={C.muted}>tab provider · ↑↓ choose · enter select · esc close</Text>}
      />
    );
  }
  const title = surface.step === "effort" ? `Effort · ${surface.model}` : `Fast mode · ${surface.model}`;
  return (
    <Menu
      title={title}
      index={surface.index}
      rows={surface.options.map((o) => ({ key: o, left: o }))}
      footer={<Text color={C.muted}>↑↓ choose · enter select · esc back</Text>}
    />
  );
}
