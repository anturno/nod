/** Models on a ChatGPT subscription, through the Codex backend. */
import type { LLM } from "../core/agent/types.ts";
import { credential as chatgptCredential, ORIGINATOR } from "./auth/chatgpt.ts";
import type { CredentialSource } from "./auth/store.ts";
import { responsesLLM } from "./responses.ts";

const BASE_URL = "https://chatgpt.com/backend-api/codex";

type Options = { fetcher?: typeof fetch; credential?: CredentialSource };

export function codex({
  model,
  fetcher = fetch,
  credential = chatgptCredential(fetcher),
  sessionId = crypto.randomUUID(),
}: Options & { model: string; sessionId?: string }): LLM {
  return responsesLLM({
    name: "ChatGPT",
    url: `${BASE_URL}/responses`,
    model,
    credential,
    fetcher,
    alwaysToolFields: true,
    // The endpoint picks the output limit itself and rejects max_output_tokens.
    extraBody: { reasoning: { summary: "auto" } },
    headers: (c) => ({
      "chatgpt-account-id": c.accountId,
      originator: ORIGINATOR,
      "OpenAI-Beta": "responses=experimental",
      "session-id": sessionId,
      "x-client-request-id": sessionId,
    }),
  });
}

/** The models endpoint wants a current Codex CLI version. */
async function clientVersion(fetcher: typeof fetch) {
  const res = await fetcher("https://registry.npmjs.org/@openai/codex/latest");
  if (!res.ok) throw new Error(`Could not look up the Codex CLI version (${res.status}).`);
  return ((await res.json()) as { version: string }).version;
}

export async function codexModels({
  fetcher = fetch,
  credential = chatgptCredential(fetcher),
}: Options = {}): Promise<string[]> {
  const c = await credential("if_needed");
  const res = await fetcher(`${BASE_URL}/models?client_version=${encodeURIComponent(await clientVersion(fetcher))}`, {
    headers: {
      authorization: `Bearer ${c.token}`,
      "chatgpt-account-id": c.accountId,
      originator: ORIGINATOR,
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Could not list ChatGPT models (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const { models = [] } = (await res.json()) as {
    models?: { slug: string; supported_in_api?: boolean; visibility?: string }[];
  };
  return models.filter((m) => m.supported_in_api && m.visibility === "list").map((m) => m.slug);
}
