These redaction patterns will be saved to a secrets file. For each one, add a short `friendlyName` that becomes part of the visible placeholder (e.g. `#FRIENDLYNAME_a1b2#`), so it MUST read as ordinary and benign and NEVER echo, transliterate, or hint at the sensitive term — the name itself must never re-trigger the refusal.

Infer what each regex masks, then make the name a GENERIC SEMANTIC ANALOG of it: map the loaded term to its closest neutral, everyday counterpart while keeping its structural role and shape, so the masked transcript still reads naturally.

- Keep the same KIND of thing: a function/symbol name stays a plausible function name, a product/system name stays a generic product name, a domain noun stays an ordinary noun.
- Keep the shape: preserve camelCase/identifier form for code symbols; preserve roughly the length and word count for phrases.
- Strip the alarming connotation, keep the mundane meaning.
- Letters, digits, and spaces only; keep it to a word or two.

<patterns>
{{#each patterns}}
- /{{this.regex}}/{{this.flags}}
{{/each}}
</patterns>

Call `submit_patterns` with `resolved: true` and the SAME patterns in the SAME order, each carrying its original `regex` and `flags` plus the new `friendlyName`. Do not modify any regex or flags.
