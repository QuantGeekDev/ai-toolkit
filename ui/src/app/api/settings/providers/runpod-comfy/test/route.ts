import fs from 'fs';
import { NextResponse } from 'next/server';
import {
  getRunPodComfyConfig,
  runPodComfySecretStatus,
  validateRunPodComfyConfig,
} from '../../../../../../../cron/comfy/settings';
import { ComfyPodClient } from '../../../../../../../cron/comfy/podClient';
import { safeErrorMessage } from '../../../../../../../cron/remote/redact';

export async function POST() {
  const config = await getRunPodComfyConfig();
  const errors = validateRunPodComfyConfig(config);
  if (errors.length) {
    return NextResponse.json({ ok: false, errors, secrets: runPodComfySecretStatus() }, { status: 422 });
  }
  try {
    await fs.promises.access(config.stagingDirectory, fs.constants.R_OK | fs.constants.W_OK);
    const pods = await new ComfyPodClient(config).list();
    return NextResponse.json({
      ok: true,
      errors: [],
      gpuIds: config.gpuIds,
      imageDigest: config.imageDigest,
      managedPodCount: pods.filter(pod => pod.name.startsWith('aitk-comfy-')).length,
      secrets: runPodComfySecretStatus(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        errors: [safeErrorMessage(error)],
        secrets: runPodComfySecretStatus(),
      },
      { status: 502 },
    );
  }
}
