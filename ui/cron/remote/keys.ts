export const VOLUME_NAMESPACE = 'aitk';

export const toObjectKey = (workerRelativeKey: string): string =>
  `${VOLUME_NAMESPACE}/${workerRelativeKey.replace(/^\/+/, '')}`;

export const bundleWorkerKey = (contentDigest: string, archiveSha256: string): string =>
  `bundles/${contentDigest.replace(/^sha256:/, '')}/${archiveSha256}.tar.gz`;

export const runWorkerPrefix = (executionId: string): string => `runs/${executionId}`;
