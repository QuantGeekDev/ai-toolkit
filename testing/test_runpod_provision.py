import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from remote.runpod.provision import ProvisionError, ProvisionSpec, RunPodRestClient, provision


IMAGE = f"ghcr.io/example/aitk@sha256:{'a' * 64}"


def spec() -> ProvisionSpec:
    return ProvisionSpec(
        name_prefix="aitk-test",
        datacenter_id="EU-RO-1",
        volume_size_gb=200,
        container_disk_gb=30,
        worker_image=IMAGE,
        gpu_type_id="NVIDIA H100 80GB HBM3",
        hf_secret_name="aitk_hf_read",
        execution_timeout_ms=10_800_000,
        ttl_ms=21_600_000,
    )


class FakeClient:
    def __init__(self, resources=None):
        self.resources = resources or {"networkvolumes": [], "templates": [], "endpoints": []}
        self.created = []

    def list(self, resource):
        return list(self.resources[resource])

    def create(self, resource, body):
        item = {"id": f"{resource}-id", **body}
        self.resources[resource].append(item)
        self.created.append((resource, body))
        return item


class RunPodProvisionTests(unittest.TestCase):
    def test_plan_does_not_create_resources(self):
        client = FakeClient()
        result = provision(client, spec(), apply=False)
        self.assertEqual(
            result["actions"],
            ["create network volume", "create worker template", "create endpoint"],
        )
        self.assertNotIn("resources", result)
        self.assertEqual(client.created, [])

    def test_apply_creates_strict_scale_to_zero_endpoint_and_safe_secret_reference(self):
        client = FakeClient()
        result = provision(client, spec(), apply=True)
        self.assertEqual([resource for resource, _ in client.created], ["networkvolumes", "templates", "endpoints"])
        template = client.created[1][1]
        self.assertEqual(template["env"]["HF_TOKEN"], "{{ RUNPOD_SECRET_aitk_hf_read }}")
        self.assertEqual(template["env"]["AITK_REQUIRE_H100"], "1")
        self.assertEqual(template["containerDiskInGb"], 30)
        endpoint = client.created[2][1]
        self.assertEqual(endpoint["workersMin"], 0)
        self.assertEqual(endpoint["workersMax"], 1)
        self.assertEqual(endpoint["idleTimeout"], 5)
        self.assertEqual(endpoint["gpuTypeIds"], ["NVIDIA H100 80GB HBM3"])
        self.assertEqual(endpoint["networkVolumeId"], "networkvolumes-id")
        self.assertEqual(result["aiToolkitSettings"]["RUNPOD_ENDPOINT_ID"], "endpoints-id")
        self.assertNotIn("RUNPOD_API_KEY", result["aiToolkitSettings"])

    def test_second_apply_reuses_matching_resources(self):
        desired = spec()
        resources = {
            "networkvolumes": [
                {
                    "id": "volume-id",
                    "name": desired.volume_name,
                    "dataCenterId": desired.datacenter_id,
                    "size": desired.volume_size_gb,
                }
            ],
            "templates": [
                {
                    "id": "template-id",
                    "name": desired.template_name,
                    "imageName": desired.worker_image,
                    "containerDiskInGb": desired.container_disk_gb,
                    "isServerless": True,
                    "env": {
                        "AITK_REQUIRE_H100": "1",
                        "AITK_WORKER_IMAGE_DIGEST": desired.worker_image,
                        "HF_TOKEN": "{{ RUNPOD_SECRET_aitk_hf_read }}",
                    },
                }
            ],
            "endpoints": [
                {
                    "id": "endpoint-id",
                    "name": desired.endpoint_name,
                    "templateId": "template-id",
                    "networkVolumeId": "volume-id",
                    "computeType": "GPU",
                    "gpuCount": 1,
                    "gpuTypeIds": [desired.gpu_type_id],
                    "dataCenterIds": desired.datacenter_id,
                    "idleTimeout": 5,
                    "executionTimeoutMs": desired.execution_timeout_ms,
                    "scalerType": "QUEUE_DELAY",
                    "scalerValue": 4,
                    "workersMin": 0,
                    "workersMax": 1,
                }
            ],
        }
        client = FakeClient(resources)
        result = provision(client, desired, apply=True)
        self.assertEqual(result["actions"], ["reuse network volume", "reuse worker template", "reuse endpoint"])
        self.assertEqual(client.created, [])

    def test_existing_resource_drift_is_a_hard_failure(self):
        desired = spec()
        client = FakeClient(
            {
                "networkvolumes": [
                    {
                        "id": "volume-id",
                        "name": desired.volume_name,
                        "dataCenterId": desired.datacenter_id,
                        "size": 100,
                    }
                ],
                "templates": [],
                "endpoints": [],
            }
        )
        with self.assertRaisesRegex(ProvisionError, "network volume size"):
            provision(client, desired, apply=True)
        self.assertEqual(client.created, [])

    def test_duplicate_names_are_rejected(self):
        desired = spec()
        client = FakeClient(
            {
                "networkvolumes": [
                    {"id": "one", "name": desired.volume_name},
                    {"id": "two", "name": desired.volume_name},
                ],
                "templates": [],
                "endpoints": [],
            }
        )
        with self.assertRaisesRegex(ProvisionError, "Multiple RunPod network volume"):
            provision(client, desired, apply=False)

    def test_http_error_redacts_api_key(self):
        api_key = "rpa_should_never_leak"
        error = urllib.error.HTTPError(
            "https://rest.runpod.io/v1/endpoints",
            401,
            "Unauthorized",
            {},
            io.BytesIO(f'{{"message":"Bearer {api_key}"}}'.encode()),
        )
        opener = mock.Mock(side_effect=error)
        client = RunPodRestClient(api_key, opener=opener)
        with self.assertRaises(ProvisionError) as caught:
            client.request("GET", "endpoints")
        self.assertNotIn(api_key, str(caught.exception))
        self.assertIn("[REDACTED]", str(caught.exception))

    def test_written_result_contains_no_credentials(self):
        # The lower-level result is what main writes; verify the invariant with
        # a realistic apply rather than invoking the network-facing CLI.
        result = provision(FakeClient(), spec(), apply=True)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "provision.json"
            target.write_text(json.dumps(result), encoding="utf-8")
            content = target.read_text(encoding="utf-8")
        self.assertNotIn("RUNPOD_API_KEY", content)
        self.assertNotIn("RUNPOD_S3_SECRET", content)


if __name__ == "__main__":
    unittest.main()
