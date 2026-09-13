/** Subscription providers: how to sign in and out, list models, and build the LLM. */
import type { LLM } from "../core/agent/types.ts";
import * as chatgpt from "./auth/chatgpt.ts";
import * as grokAuth from "./auth/grok.ts";
import { openBrowser } from "./auth/oauth.ts";
import { loadSession, removeSession, saveSession } from "./auth/store.ts";
import { codex, codexModels } from "./codex.ts";
import { grok, grokModels } from "./grok.ts";

export type LoginIO = { print(line: string): void; manualCode?: () => Promise<string> };

export type Subscription = {
  label: string;
  login(io: LoginIO): Promise<void>;
  /** Returns what happened, for the user. */
  logout(): Promise<string>;
  signedIn(): boolean;
  models(): Promise<string[]>;
  /** Used when no --model is given and the subscription lists it; otherwise the first listed model. */
  defaultModel?: string;
  llm(model: string): LLM;
};

const onUrl = (io: LoginIO) => (url: string) => {
  io.print(`Open this URL to sign in:\n\n${url}\n`);
  openBrowser(url);
};

export const subscriptions: Record<"codex" | "grok", Subscription> = {
  codex: {
    label: "ChatGPT",
    async login(io) {
      saveSession(chatgpt.PROVIDER, await chatgpt.login({ onUrl: onUrl(io) }));
    },
    async logout() {
      return removeSession(chatgpt.PROVIDER) ? "Signed out of ChatGPT." : "Not signed in to ChatGPT.";
    },
    signedIn: () => loadSession(chatgpt.PROVIDER) !== undefined,
    models: () => codexModels(),
    defaultModel: "gpt-5.6-luna",
    llm: (model) => codex({ model }),
  },
  grok: {
    label: "Grok",
    async login(io) {
      saveSession(grokAuth.PROVIDER, await grokAuth.login({ onUrl: onUrl(io), manualCode: io.manualCode?.() }));
    },
    async logout() {
      const { removed, revoked } = await grokAuth.logout();
      if (!removed) return "Not signed in to Grok.";
      return revoked
        ? "Signed out of Grok."
        : "Removed the local Grok session, but xAI did not confirm the token was revoked.";
    },
    signedIn: () => loadSession(grokAuth.PROVIDER) !== undefined,
    models: () => grokModels(),
    llm: (model) => grok({ model }),
  },
};

export type Provider = keyof typeof subscriptions;
export const providers = Object.keys(subscriptions) as Provider[];
export const isSubscription = (name: string): name is Provider => Object.hasOwn(subscriptions, name);

/**
 * The subscription and model to use: the given provider, else NOD_PROVIDER, else the first signed-in subscription;
 * the given model, else the subscription's preferred one if it lists it, else the first listed.
 */
export async function pickModel(
  provider = process.env.NOD_PROVIDER ?? providers.find((p) => subscriptions[p].signedIn()),
  model?: string,
) {
  if (!provider)
    throw new Error("Sign in with a subscription first: nod login codex (ChatGPT) or nod login grok (Grok)");
  if (!isSubscription(provider)) throw new Error(`Unknown provider "${provider}". Use codex or grok.`);
  const sub = subscriptions[provider];
  if (!sub.signedIn()) throw new Error(`Not signed in. Run: nod login ${provider}`);
  if (!model) {
    const listed = await sub.models();
    model = sub.defaultModel && listed.includes(sub.defaultModel) ? sub.defaultModel : listed[0];
  }
  if (!model) throw new Error(`Your ${sub.label} subscription lists no models.`);
  return { provider, model, sub };
}

/** Every subscription's models as `provider/model`. One that is signed out or unreachable is listed, disabled, with why. */
export async function listModels(): Promise<{ value: string; hint?: string; disabled?: boolean }[]> {
  const lists = providers.map(async (name) => {
    const sub = subscriptions[name];
    if (!sub.signedIn()) return [{ value: name, hint: `not signed in · nod login ${name}`, disabled: true }];
    return sub.models().then(
      (ids) => ids.map((id) => ({ value: `${name}/${id}` })),
      (e: Error) => [{ value: name, hint: e.message.split("\n")[0], disabled: true }],
    );
  });
  return (await Promise.all(lists)).flat();
}

/** The LLM for a `provider/model` value from listModels. */
export function llmFor(value: string): LLM {
  const at = value.indexOf("/");
  return subscriptions[value.slice(0, at) as Provider].llm(value.slice(at + 1));
}
