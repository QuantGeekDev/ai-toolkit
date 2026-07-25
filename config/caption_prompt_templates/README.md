# Caption prompt templates

The New Caption Job dialog reads prompt templates from this directory. Each `*.json` file except `index.json`
is one independently versioned prompt variation. `index.json` records which template is loaded by default when a
new prompt-aware captioner is selected.

Use lowercase letters, numbers, dots, underscores, or hyphens for filenames. To test a variation without losing
the original, save it under a new ID such as `krea2-identity-v2.json`. The UI writes stable, formatted JSON so the
resulting prompt changes are easy to review in Git.

Template files use this schema:

```json
{
  "schema_version": 1,
  "label": "Human-readable label",
  "description": "What this prompt is intended to test",
  "family": "optional grouping label",
  "prompt": "The complete captioning prompt"
}
```
