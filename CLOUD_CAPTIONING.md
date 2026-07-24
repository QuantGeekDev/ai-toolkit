# Cloud API captioning

AI Toolkit can caption image datasets with a hosted vision model from the same **Caption Dataset** dialog used by local captioners. The initial provider is Google Gemini using `gemini-3.1-pro-preview`.

## Setup

1. Install or update AI Toolkit's Python requirements. Cloud captioning requires `google-genai>=2.14.0,<3`.
2. Create a Gemini authorization key in Google AI Studio and restrict it to the Gemini API.
3. Prefer setting `GEMINI_API_KEY` before starting the AI Toolkit UI. Alternatively, open **Settings**, enter the key, save it, and use **Test Gemini connection**.
4. Open a dataset, select **Caption Dataset**, then select **Gemini 3.1 Pro (Preview)**.
5. Review the prompt and settings, then add the job to the queue.

Keys supplied through the environment take precedence. A key saved in Settings is stored in AI Toolkit's local SQLite database and is not encrypted at rest. Secret values are not returned to the browser and are never included in job configuration files.

## Defaults

- Model: `gemini-3.1-pro-preview`
- Reasoning: high
- Media resolution: high
- Concurrent requests: 2
- Maximum attempts: 4, including the initial request
- Request timeout: 120 seconds
- Structured output: a JSON object containing one caption

The integration uses the stable `generateContent` API behind a provider-neutral adapter. Requests are independent and stateless. The adapter can move to the Interactions API later without changing UI or job configurations.

## Behavior and recovery

- Cloud jobs use a dedicated **Cloud API** queue and do not reserve CUDA or MPS. They can run alongside GPU training.
- Existing captions are skipped unless **Recaption** is enabled.
- Caption files are written through an atomic same-directory replacement. If a request or write fails, an existing caption remains intact.
- Authentication, invalid-model, and invalid-request failures stop the job. Image validation, safety blocks, exhausted transient failures, and malformed responses are recorded per image while remaining images continue.
- Failure details are written to `caption_failures.jsonl` in the job output folder. Records contain no image bytes or credentials.
- Cancelling a job stops new work from being scheduled. Requests already in flight are bounded by the configured timeout.

## Advanced configuration

See [`config/examples/caption_directory_gemini.yml`](config/examples/caption_directory_gemini.yml). Credentials are intentionally rejected in job YAML; use `GEMINI_API_KEY` or Settings.

The model ID is editable because preview model names can be retired. AI Toolkit never silently substitutes another model or paid provider.

## Adding another provider

Provider adapters live under `extensions_built_in/captioner/providers/` and implement the `CaptionProvider` protocol:

- validate provider-specific configuration;
- accept a neutral `CaptionRequest` containing encoded image bytes, MIME type, prompt, and diagnostic source name;
- return a neutral `CaptionResult`;
- translate provider failures into the stable provider exception taxonomy;
- close network resources.

Register the adapter explicitly in `providers/__init__.py`, add server-only credential resolution, and add provider metadata/defaults in `ui/src/helpers/captionOptions.ts`. Do not add automatic paid-provider fallback.

## Privacy and cost

Images selected for cloud captioning leave the machine and are processed under Google's Gemini API terms. High reasoning and high media resolution can increase latency and token usage. AI Toolkit records token usage when the API supplies it but does not estimate cost because preview pricing can change.
