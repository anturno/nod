# Node readline chat

A command-line chat over one `createAgent` conversation. Sign in first (`nod login codex` or `nod login grok`), then:

```sh
bun run examples/node-chat/chat.ts
```

Set `NOD_PROVIDER=grok` to use the Grok subscription and `NOD_MODEL=<id>` to pick a model. Type `/exit` to quit.
