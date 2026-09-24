/** The root: subscribes to the core store, forwards raw stdin bytes, lays out transcript · activity · surface · composer. */
import { Box, useApp, useStdin, useWindowSize } from "ink";
import { useEffect, useSyncExternalStore } from "react";
import type { Provider } from "../../core/agent/types.ts";
import type { Subscription } from "../../providers/providers.ts";
import { activeQuery } from "../core/pickers.ts";
import { diffText, type TerminalCore } from "../core/terminal.ts";
import { C } from "../theme.ts";
import { Activity } from "./Activity.tsx";
import { Approval, Diff } from "./Approval.tsx";
import { Composer } from "./Composer.tsx";
import { FilePicker, SkillPicker } from "./FilePicker.tsx";
import { FullTranscript } from "./FullTranscript.tsx";
import { HintRow } from "./HintRow.tsx";
import { McpBrowser } from "./McpBrowser.tsx";
import { Menu } from "./Menu.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { Question } from "./Question.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { SlashMenu } from "./SlashMenu.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { Transcript } from "./Transcript.tsx";

export type AppProps = { core: TerminalCore; subscriptions: Record<Provider, Subscription>; now: () => number };

export function App({ core, subscriptions, now }: AppProps) {
  const state = useSyncExternalStore(core.store.subscribe, core.store.get);
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { columns, rows } = useWindowSize();

  useEffect(() => {
    const onData = (chunk: Buffer | string) => core.feed(chunk.toString());
    stdin.on("data", onData);
    return () => void stdin.off("data", onData);
  }, [stdin, core]);
  useEffect(() => core.resize(columns, rows), [core, columns, rows]);
  useEffect(() => {
    if (state.exited !== null) exit(state.exited as unknown as Error);
  }, [state.exited, exit]);

  if (state.screen && state.screen.kind !== "diff")
    return <FullTranscript items={state.items} depth={state.screen.kind} scroll={state.screen.scroll} rows={rows} />;

  const border = state.mode === "yolo" ? C.error : C.border;
  const query = state.surface ? null : activeQuery(state.editor, state.menu.dismissed);
  const docked = query !== null;
  const surface = state.surface;
  const approval = surface?.kind === "approval" ? surface.state : null;
  const diff = approval?.request.preparation?.diff;

  if (state.screen?.kind === "diff" && approval && diff)
    return (
      <Box flexDirection="column" height={rows}>
        <Box flexGrow={1} overflow="hidden" paddingX={2}>
          <Diff text={diffText(diff)} scroll={state.screen.scroll} height={Math.max(1, rows - 10)} />
        </Box>
        <Approval state={approval} onScreen />
      </Box>
    );

  return (
    <Box flexDirection="column" height={rows} paddingTop={1}>
      <Transcript
        items={state.items}
        collapse={state.settings.collapseToolCalls}
        scroll={state.scroll}
        cwd={state.status.cwd}
        branch={state.status.branch}
        version={state.version}
      />
      {state.activity && <Activity activity={state.activity} usage={state.turnUsage} now={now} />}
      {approval && <Approval state={approval} />}
      {surface?.kind === "question" && <Question state={surface.state} />}
      {surface?.kind === "model" && <ModelMenu surface={surface} subscriptions={subscriptions} />}
      {surface?.kind === "sessions" && <SessionPicker surface={surface} now={now()} />}
      {surface?.kind === "settings" && <SettingsMenu surface={surface} />}
      {surface?.kind === "mcp" && <McpBrowser />}
      {surface?.kind === "list" && (
        <Menu
          title={surface.title}
          index={surface.index}
          rows={surface.rows.map((r) => ({
            key: r.value,
            left: r.label ?? r.value,
            right: r.hint,
            disabled: r.disabled,
          }))}
        />
      )}
      {query?.kind === "slash" && (
        <SlashMenu
          prefix={query.prefix}
          tab={state.menu.tab}
          index={state.menu.index}
          categories={state.settings.slashMenuCategories}
          borderColor={border}
        />
      )}
      {query?.kind === "file" && <FilePicker rows={state.fileRows} index={state.menu.index} borderColor={border} />}
      {query?.kind === "skill" && <SkillPicker rows={state.skillRows} index={state.menu.index} borderColor={border} />}
      <Composer
        editor={state.editor}
        cwd={state.status.cwd}
        borderColor={border}
        docked={docked}
        showCursor={!approval && surface?.kind !== "question"}
      />
      <HintRow
        mode={state.mode}
        model={state.model}
        effort={state.effort}
        fast={state.fast}
        ctrlCArmed={state.ctrlCArmed}
        updateLabel={state.updateLabel}
      />
      <StatusLine status={state.status} toggles={state.settings.statusLine} />
    </Box>
  );
}
