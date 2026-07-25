import { NextResponse } from 'next/server';
import { getRunPodConfig, runPodSecretStatus, validateRunPodConfig } from '../../../../../../../cron/remote/settings';
import { RunPodClient } from '../../../../../../../cron/remote/runpodClient';

export async function POST() {
  const config = await getRunPodConfig();
  const errors = validateRunPodConfig(config);
  if (errors.length) return NextResponse.json({ ok: false, errors, secrets: runPodSecretStatus() }, { status: 422 });
  try {
    const preflight = await new RunPodClient(config).preflight();
    return NextResponse.json(
      {
        ok: preflight.ok,
        errors: preflight.errors,
        warnings: preflight.warnings,
        endpointId: config.endpointId,
        expectedNetworkVolumeId: config.networkVolumeId,
        expectedWorkerImageDigest: config.workerImageDigest,
        secrets: runPodSecretStatus(),
      },
      { status: preflight.ok ? 200 : 422 },
    );
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, errors: [error?.message || 'RunPod preflight failed.'], secrets: runPodSecretStatus() },
      { status: 502 },
    );
  }
}
