# Cloud API captioning

AI Toolkit can caption image datasets with a hosted vision model from the same **Caption Dataset** dialog used by local captioners. The initial provider is Google Gemini using `gemini-3.1-pro-preview`.

## Choose a Google backend

The Gemini adapter supports two explicit backends and never silently switches between them:

- **Gemini Developer API** authenticates with `GEMINI_API_KEY`. Billing and quota follow the Google AI Studio project that owns the key.
- **Vertex AI / Gemini Enterprise** authenticates with Application Default Credentials (ADC). Billing and quota follow the `project` named in the job configuration.

## Developer API setup

1. Install or update AI Toolkit's Python requirements. Cloud captioning requires `google-genai>=2.14.0,<3`.
2. Create a Gemini authorization key in Google AI Studio and restrict it to the Gemini API.
3. Prefer setting `GEMINI_API_KEY` before starting the AI Toolkit UI. Alternatively, open **Settings**, enter the key, save it, and use **Test Gemini connection**.
4. Open a dataset, select **Caption Dataset**, then select **Gemini 3.1 Pro (Preview)** and **Gemini Developer API**.
5. Review the prompt and settings, then add the job to the queue.

Keys supplied through the environment take precedence. A key saved in Settings is stored in AI Toolkit's local SQLite database and is not encrypted at rest. Secret values are not returned to the browser and are never included in job configuration files.

## Vertex AI setup and billing verification

1. Enable billing and the Vertex AI API on the intended Google Cloud project.
2. Grant the identity running AI Toolkit `roles/aiplatform.user` on that project.
3. Create ADC with `gcloud auth application-default login`, or supply a service-account/workload-identity ADC JSON file.
4. In **Settings → Vertex AI / Gemini Enterprise**, enter the project ID, `global` location, and absolute ADC JSON path.
5. Use **Test Vertex AI connection**. The success message returns the exact project and location used by the SDK.
6. In the caption dialog select **Vertex AI / Gemini Enterprise**. The project and location are stored in the job config for auditability; credentials are not.

The worker initializes the current Google Gen AI SDK with `enterprise=True`, the configured project, the `global` location, ADC, and the stable `v1` API. Because the project is part of the Vertex resource path, usage is attributed to that project's attached Cloud Billing account. The ADC file's quota project should match; verify it with `gcloud auth application-default set-quota-project PROJECT_ID`.

## Defaults

- Model: `gemini-3.1-pro-preview`
- Backend: Gemini Developer API (existing-job compatibility)
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

See [`config/examples/caption_directory_gemini.yml`](config/examples/caption_directory_gemini.yml) and [`config/examples/caption_directory_gemini_vertex.yml`](config/examples/caption_directory_gemini_vertex.yml). Credentials and ADC paths are intentionally rejected in job YAML; configure them through the environment or Settings.

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

Images selected for cloud captioning leave the machine and are processed under the terms for the selected Google backend. High reasoning and high media resolution can increase latency and token usage. AI Toolkit records token usage when the API supplies it but does not estimate cost because preview pricing can change.
