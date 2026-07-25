import os
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from PIL import Image

from extensions_built_in.captioner.BaseCaptioner import BaseCaptioner
from extensions_built_in.captioner.CloudCaptioner import CloudCaptionConfig
from extensions_built_in.captioner.CloudCaptioner import CloudCaptioner
from extensions_built_in.captioner.providers.base import (
    CaptionRequest,
    ProviderAuthenticationError,
    ProviderConfigurationError,
    ProviderResponseError,
    CaptionResult,
)
from extensions_built_in.captioner.providers.gemini import GeminiCaptionProvider
from extensions_built_in.captioner.providers.image_utils import prepare_image


class FakeModels:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FakeClient:
    def __init__(self, responses):
        self.models = FakeModels(responses)
        self.closed = False

    def close(self):
        self.closed = True


def response(text='{"caption":"A café sign 日本語"}', finish_reason="STOP"):
    usage = SimpleNamespace(
        prompt_token_count=100,
        candidates_token_count=20,
        thoughts_token_count=30,
        total_token_count=150,
    )
    return SimpleNamespace(
        parsed=None,
        text=text,
        candidates=[SimpleNamespace(finish_reason=finish_reason)],
        usage_metadata=usage,
        sdk_http_response=SimpleNamespace(headers={"x-request-id": "request-123"}),
    )


class CodedError(Exception):
    def __init__(self, code, message="provider failure"):
        super().__init__(message)
        self.code = code


class CloudCaptionConfigTests(unittest.TestCase):
    def test_resolves_caption_prompt_template_when_prompt_is_omitted(self):
        with tempfile.TemporaryDirectory() as folder:
            config = CloudCaptionConfig(
                path_to_caption=folder,
                caption_prompt_template="krea2_identity",
            )
            self.assertEqual(config.caption_prompt_template, "krea2_identity")
            self.assertIn("Krea 2 identity LoRA", config.caption_prompt)
            self.assertIn("[trigger] person", config.caption_prompt)

    def test_explicit_caption_prompt_overrides_template_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            config = CloudCaptionConfig(
                path_to_caption=folder,
                caption_prompt_template="krea2_identity",
                caption_prompt="My exact prompt",
            )
            self.assertEqual(config.caption_prompt, "My exact prompt")

    def test_unknown_caption_prompt_template_is_rejected_when_used(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "Unknown caption_prompt_template"):
                CloudCaptionConfig(
                    path_to_caption=folder,
                    caption_prompt_template="missing",
                    caption_prompt="",
                )

    def test_defaults_are_high_reasoning_and_cloud_safe(self):
        with tempfile.TemporaryDirectory() as folder:
            config = CloudCaptionConfig(path_to_caption=folder)
        self.assertEqual(config.provider, "gemini")
        self.assertEqual(config.model, "gemini-3.1-pro-preview")
        self.assertEqual(config.concurrency, 2)
        self.assertEqual(config.device, "cpu")

    def test_rejects_credentials_in_job_config(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "Credentials"):
                CloudCaptionConfig(path_to_caption=folder, provider_options={"api_key": "secret"})

    def test_rejects_unsafe_caption_extension(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "caption_extension"):
                CloudCaptionConfig(path_to_caption=folder, caption_extension="../txt")

    def test_rejects_storage_and_legacy_thinking_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "stateless"):
                CloudCaptionConfig(path_to_caption=folder, provider_options={"store": True})
            with self.assertRaisesRegex(ValueError, "thinking_level"):
                CloudCaptionConfig(path_to_caption=folder, provider_options={"thinking_budget": 1000})

    def test_rejects_adc_credentials_in_job_config(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "Credentials"):
                CloudCaptionConfig(
                    path_to_caption=folder,
                    provider_options={"credentials_file": "C:/secret/adc.json"},
                )


class GeminiProviderTests(unittest.TestCase):
    def make_provider(self, responses, **kwargs):
        client = FakeClient(responses)
        provider = GeminiCaptionProvider(
            model="gemini-3.1-pro-preview",
            thinking_level="high",
            media_resolution="high",
            client=client,
            **kwargs,
        )
        return provider, client

    def test_request_wires_model_reasoning_resolution_and_schema(self):
        provider, client = self.make_provider([response()])
        result = provider.caption(CaptionRequest(b"image", "image/jpeg", "Caption it", "fixture.jpg"))

        self.assertEqual(result.caption, "A café sign 日本語")
        self.assertEqual(result.request_id, "request-123")
        self.assertEqual(result.usage.thoughts_tokens, 30)
        self.assertEqual(result.metadata["backend"], "developer")
        call = client.models.calls[0]
        self.assertEqual(call["model"], "gemini-3.1-pro-preview")
        self.assertEqual(call["config"].thinking_config.thinking_level.value, "HIGH")
        self.assertEqual(call["contents"][1].media_resolution.level.value, "MEDIA_RESOLUTION_HIGH")
        self.assertEqual(call["config"].response_mime_type, "application/json")
        self.assertEqual(call["config"].response_json_schema["required"], ["caption"])

    def test_max_tokens_retries_once_with_larger_budget(self):
        provider, client = self.make_provider(
            [response(text="", finish_reason="MAX_TOKENS"), response('{"caption":"Recovered"}')],
            max_output_tokens=1024,
        )
        result = provider.caption(CaptionRequest(b"image", "image/jpeg", "Caption it", "fixture.jpg"))
        self.assertEqual(result.caption, "Recovered")
        self.assertEqual(result.attempts, 2)
        self.assertEqual(client.models.calls[0]["config"].max_output_tokens, 1024)
        self.assertEqual(client.models.calls[1]["config"].max_output_tokens, 2048)

    def test_auth_errors_are_sanitized_and_job_fatal(self):
        canary = "canary-secret-key"
        provider, _ = self.make_provider([CodedError(403, f"bad key {canary}")])
        with self.assertRaises(ProviderAuthenticationError) as raised:
            provider.caption(CaptionRequest(b"image", "image/jpeg", "Caption it", "fixture.jpg"))
        self.assertTrue(raised.exception.job_fatal)
        self.assertNotIn(canary, str(raised.exception))

    def test_invalid_reasoning_level_fails_before_request(self):
        with self.assertRaises(ProviderConfigurationError):
            GeminiCaptionProvider(model="model", thinking_level="maximum", client=FakeClient([]))

    def test_vertex_backend_uses_enterprise_client_project_global_and_v1(self):
        fake_client = FakeClient([])
        with patch("google.genai.Client", return_value=fake_client) as client_factory:
            provider = GeminiCaptionProvider(
                model="gemini-3.1-pro-preview",
                backend="vertex",
                project="billing-project-123",
                location="global",
            )
        kwargs = client_factory.call_args.kwargs
        self.assertTrue(kwargs["enterprise"])
        self.assertEqual(kwargs["project"], "billing-project-123")
        self.assertEqual(kwargs["location"], "global")
        self.assertEqual(kwargs["http_options"].api_version, "v1")
        provider.close()
        self.assertTrue(fake_client.closed)

    def test_vertex_backend_records_billing_route_in_result_metadata(self):
        provider, _ = self.make_provider(
            [response('{"caption":"Vertex caption"}')],
            backend="vertex",
            project="billing-project-123",
            location="global",
        )
        result = provider.caption(CaptionRequest(b"image", "image/jpeg", "Caption it", "fixture.jpg"))
        self.assertEqual(result.metadata["backend"], "vertex")
        self.assertEqual(result.metadata["project"], "billing-project-123")
        self.assertEqual(result.metadata["location"], "global")

    def test_vertex_requires_project_and_global_for_gemini_31_pro(self):
        with self.assertRaisesRegex(ProviderConfigurationError, "project"):
            GeminiCaptionProvider(
                model="gemini-3.1-pro-preview",
                backend="vertex",
                client=FakeClient([]),
            )
        with self.assertRaisesRegex(ProviderConfigurationError, "global"):
            GeminiCaptionProvider(
                model="gemini-3.1-pro-preview",
                backend="vertex",
                project="billing-project-123",
                location="us-central1",
                client=FakeClient([]),
            )

    def test_unknown_backend_is_rejected(self):
        with self.assertRaisesRegex(ProviderConfigurationError, "backend"):
            GeminiCaptionProvider(model="model", backend="mystery", client=FakeClient([]))


class ImagePreparationTests(unittest.TestCase):
    def test_transparent_png_stays_png_and_source_is_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "alpha.png")
            Image.new("RGBA", (32, 16), (255, 0, 0, 100)).save(path)
            with open(path, "rb") as handle:
                before = handle.read()
            prepared = prepare_image(path)
            with open(path, "rb") as handle:
                after = handle.read()
        self.assertEqual(prepared.mime_type, "image/png")
        self.assertEqual((prepared.width, prepared.height), (32, 16))
        self.assertEqual(before, after)

    def test_large_image_is_resized_without_upscaling(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "large.bmp")
            Image.new("RGB", (2000, 1000), "blue").save(path)
            prepared = prepare_image(path, max_pixels=250_000)
        self.assertLessEqual(prepared.width * prepared.height, 250_000)
        self.assertEqual(prepared.mime_type, "image/jpeg")


class AtomicCaptionWriteTests(unittest.TestCase):
    def test_caption_replacement_is_atomic_and_cleans_temp_files(self):
        with tempfile.TemporaryDirectory() as folder:
            image_path = os.path.join(folder, "sample.png")
            caption_path = os.path.join(folder, "sample.txt")
            Image.new("RGB", (8, 8)).save(image_path)
            with open(caption_path, "w", encoding="utf-8") as handle:
                handle.write("old")

            captioner = BaseCaptioner.__new__(BaseCaptioner)
            captioner.caption_config = SimpleNamespace(caption_extension="txt")
            captioner.save_caption_for_file(image_path, "new caption")

            with open(caption_path, "r", encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "new caption")
            self.assertFalse(any(name.endswith(".tmp") for name in os.listdir(folder)))


class FakeConcurrentProvider:
    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()

    def caption(self, request):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(0.03)
            if request.source_name == "bad.png":
                raise ProviderResponseError("invalid response")
            return CaptionResult(
                caption=f"caption for {request.source_name}",
                provider="fake",
                model="fake-model",
            )
        finally:
            with self.lock:
                self.active -= 1


class CloudCaptionLoopIntegrationTests(unittest.TestCase):
    def test_mixed_results_are_bounded_and_preserve_old_caption(self):
        with tempfile.TemporaryDirectory() as folder:
            output = os.path.join(folder, "output")
            os.makedirs(output)
            paths = []
            for name in ["one.png", "bad.png", "two.png"]:
                path = os.path.join(folder, name)
                Image.new("RGB", (16, 16), "blue").save(path)
                paths.append(path)
            bad_caption = os.path.join(folder, "bad.txt")
            with open(bad_caption, "w", encoding="utf-8") as handle:
                handle.write("keep me")

            provider = FakeConcurrentProvider()
            captioner = CloudCaptioner.__new__(CloudCaptioner)
            captioner.caption_config = CloudCaptionConfig(
                path_to_caption=folder,
                provider="gemini",
                concurrency=2,
                recaption=True,
            )
            captioner.provider = provider
            captioner.file_paths = paths
            captioner.step_num = 0
            captioner.is_ui_captioner = False
            captioner.sqlite_db_path = os.path.join(folder, "db.sqlite")
            captioner._report_lock = threading.Lock()
            captioner._failure_report_initialized = False
            captioner.stats = {
                "captioned": 0,
                "failed": 0,
                "blocked": 0,
                "retried": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "thoughts_tokens": 0,
            }
            captioner.update_step = lambda: None
            captioner.maybe_stop = lambda: None

            old_output = os.environ.get("AITK_JOB_OUTPUT_DIR")
            os.environ["AITK_JOB_OUTPUT_DIR"] = output
            try:
                captioner.run_caption_loop()
            finally:
                if old_output is None:
                    os.environ.pop("AITK_JOB_OUTPUT_DIR", None)
                else:
                    os.environ["AITK_JOB_OUTPUT_DIR"] = old_output

            self.assertEqual(captioner.stats["captioned"], 2)
            self.assertEqual(captioner.stats["failed"], 1)
            self.assertEqual(captioner.step_num, 3)
            self.assertLessEqual(provider.max_active, 2)
            self.assertGreaterEqual(provider.max_active, 1)
            with open(bad_caption, "r", encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "keep me")
            with open(os.path.join(output, "caption_failures.jsonl"), "r", encoding="utf-8") as handle:
                report = handle.read()
            self.assertIn('"category": "response"', report)
            self.assertNotIn("image_bytes", report)

    def test_completed_caption_job_writes_exportable_dataset_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            image_path = os.path.join(folder, "one.png")
            caption_path = os.path.join(folder, "one.txt")
            Image.new("RGB", (16, 16), "blue").save(image_path)
            with open(caption_path, "w", encoding="utf-8") as handle:
                handle.write("[trigger], a blue test frame")

            captioner = CloudCaptioner.__new__(CloudCaptioner)
            captioner.caption_config = CloudCaptionConfig(
                path_to_caption=folder,
                provider="gemini",
                caption_prompt_template="krea2_identity",
                recaption=True,
            )
            captioner.job_id = "caption-job-1"
            captioner.stats = {
                "captioned": 1,
                "failed": 0,
                "blocked": 0,
                "retried": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "thoughts_tokens": 0,
            }
            captioner._write_dataset_provenance(complete=True)

            with open(os.path.join(folder, ".aitk_caption_provenance.json"), "r", encoding="utf-8") as handle:
                provenance = json.load(handle)
            self.assertTrue(provenance["complete"])
            self.assertEqual(provenance["captionJobId"], "caption-job-1")
            self.assertEqual(provenance["model"], "gemini-3.1-pro-preview")
            self.assertEqual(provenance["promptTemplateId"], "krea2_identity")
            self.assertEqual(len(provenance["promptSha256"]), 64)
            self.assertEqual(len(provenance["captions"]["one.png"]), 64)


if __name__ == "__main__":
    unittest.main()
