# Local job templates

The **New Job → Templates** dialog reads and writes this directory. Every `*.json` file except `index.json` is a complete, independent training template suitable for Git versioning.

- Use a new file ID for each experimental training procedure.
- `index.json` selects the template automatically loaded by `/jobs/new`.
- Templates contain the full job configuration and GPU selection, but never API keys or other UI secrets.
- AI Toolkit normalizes runtime-owned paths and the platform device when a template is loaded.

Commit template files alongside the code when you want the experiment definition preserved in history.
