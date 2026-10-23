# Website AI help – `POST /public/help/ask`

New, self-contained module for the "Ask Metra" assistant on the public website.
**No existing module, route, entity or the Python bot is changed.**

## Files

- `src/public-help/public-help.ts` – controller + module (new)
- `docs/user-guide/*.md` – the public user guide (same chapters as the website help center)
- `src/app.module.ts` – one import and `PublicHelpModule` added to `imports`
- `.env.example` – new settings documented

## How it works

1. The visitor's question is matched against the user guide sections (keyword ranking).
2. The best sections are sent to Gemini with strict rules: answer only from the guide, no invented prices or
   limits, reply in the visitor's language, talk only about Agent Metra.
3. Response: `{ answer, sources: [{ slug, title }] }` (wrapped by the normal response interceptor).

It never reads company or customer data and has no database access.

## Settings (.env)

```
GEMINI_API_KEY=            # empty = switched off (503); the website then uses its built-in guide answers
HELP_AI_MODEL=gemini-2.5-flash
HELP_AI_PER_MINUTE=8       # per visitor IP, on top of the global rate limit
HELP_BRAND_NAME=Agent Metra
```

When the user guide changes on the website (`src/docs/client/*.md`), copy the files to `docs/user-guide/`.
