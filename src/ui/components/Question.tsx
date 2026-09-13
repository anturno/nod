/** ask_user_question: one question at a time, numbered options with dim descriptions, a freeform Other slot. */
import { Box, Text } from "ink";
import { QUESTION_HINT, type QuestionState, questionProgress } from "../core/surfaces.ts";
import { C } from "../theme.ts";

export function Question({ state }: { state: QuestionState }) {
  const q = state.questions[state.index];
  if (!q) return null;
  const other = q.options.length;
  return (
    <Box flexDirection="column" flexShrink={0} marginX={1} paddingX={1} borderStyle="round" borderColor={C.accent}>
      <Text bold color={C.foreground}>
        {q.question}
      </Text>
      <Box height={1} />
      {q.options.map((o, i) => {
        const cursor = state.choice === i;
        return (
          <Box key={o.label}>
            <Text color={C.accent}>{cursor ? "› " : "  "}</Text>
            <Text bold={cursor} color={cursor ? C.accent : C.foreground}>
              {`${i + 1}. ${o.label}`}
            </Text>
            {o.description && <Text color={C.mutedForeground}>{`  ${o.description}`}</Text>}
          </Box>
        );
      })}
      <Box>
        <Text color={C.accent}>{state.choice === other ? "› " : "  "}</Text>
        <Text bold={state.choice === other} color={state.choice === other ? C.accent : C.foreground}>
          {`${other + 1}. Other`}
        </Text>
        {state.choice === other && (
          <Text color={state.freeform ? C.foreground : C.muted}>{`  ${state.freeform || "type your answer"}`}</Text>
        )}
      </Box>
      <Text color={C.muted}>{`${QUESTION_HINT}    ${questionProgress(state)}`}</Text>
    </Box>
  );
}
