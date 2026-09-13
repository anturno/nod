/** Models on a SuperGrok or X Premium subscription, through the Grok CLI proxy. */
import type { LLM } from "../core/agent/types.ts";
import { credential as grokCredential } from "./auth/grok.ts";
import type { CredentialSource } from "./auth/store.ts";
import { responsesLLM } from "./responses.ts";

const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const CLIENT_IDENTIFIER = "nod";

type Options = { fetcher?: typeof fetch; credential?: CredentialSource };

/** The proxy only accepts requests that name a current Grok CLI version. */
let version: Promise<string> | undefined;
function clientVersion(fetcher: typeof fetch) {
  version ??= fetcher("https://x.ai/cli/stable")
    .then(async (res) => {
      if (!res.ok) throw new Error(`Could not look up the Grok CLI version (${res.status}).`);
      return (await res.text()).trim();
    })
    .catch((e: unknown) => {
      version = undefined;
      throw e;
    });
  return version;
}

const cliHeaders = (v: string) => ({
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-grok-client-version": v,
  "x-grok-client-identifier": CLIENT_IDENTIFIER,
});

export function grok({
  model,
  fetcher = fetch,
  credential = grokCredential(fetcher),
  sessionId = crypto.randomUUID(),
}: Options & { model: string; sessionId?: string }): LLM {
  const llm = (v: string) =>
    responsesLLM({
      name: "Grok",
      url: `${BASE_URL}/responses`,
      model,
      credential,
      fetcher,
      headers: (c) => ({
        ...cliHeaders(v),
        "x-authenticateresponse": "authenticate-response",
        "x-grok-model-override": model,
        "x-grok-user-id": c.accountId,
        "x-grok-conv-id": sessionId,
      }),
    });
  return {
    async *stream(messages, tools, signal, options) {
      return yield* llm(await clientVersion(fetcher)).stream(messages, tools, signal, options);
    },
  };
}

export async function grokModels({
  fetcher = fetch,
  credential = grokCredential(fetcher),
}: Options = {}): Promise<string[]> {
  const c = await credential("if_needed");
  const headers = {
    ...cliHeaders(await clientVersion(fetcher)),
    authorization: `Bearer ${c.token}`,
    "x-userid": c.accountId,
    accept: "application/json",
  };
  const res = await fetcher(`${BASE_URL}/models`, { headers });
  if (!res.ok) throw new Error(`Could not list Grok models (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const { data = [] } = (await res.json()) as { data?: { id: string; api_backend?: string }[] };
  return data.filter((m) => m.api_backend === "responses").map((m) => m.id);
}
