// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/utils/api';
import ComfyWorkspacePanel, { type TemporaryH100Capability } from './ComfyWorkspacePanel';

vi.mock('@/utils/api', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

const checkpoints = [
  { fileName: 'job.safetensors', label: 'Final', size: 1024 ** 3, step: 1000, isFinal: true },
  { fileName: 'job_000500.safetensors', label: 'Step 500', size: 1024 ** 3, step: 500, isFinal: false },
];

const capability: TemporaryH100Capability = {
  available: true,
  error: null,
  configurationErrors: [],
  durationChoices: [1, 2, 4, 8],
  defaultMaxHours: 2,
  idleMinutes: 60,
  maxHourlyRate: 3.5,
  gpuIds: ['NVIDIA H100 80GB HBM3'],
  comparisonCheckpointBytes: 2 * 1024 ** 3,
  comparisonContainerDiskGb: 100,
  activeWorkspace: null,
};

describe('temporary H100 workspace panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('defaults to all checkpoints, two hours, output preservation, and a bounded estimate', () => {
    render(<ComfyWorkspacePanel jobId="job-1" checkpoints={checkpoints} capability={capability} />);

    expect((screen.getByLabelText(/All checkpoints \+ No LoRA/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Maximum duration/i) as HTMLSelectElement).value).toBe('2');
    expect((screen.getByLabelText(/Copy generated images/i) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/\$7\.00/)).toBeTruthy();
    expect(screen.getByText(/100 GB container disk/)).toBeTruthy();
  });

  it('requires explicit billable confirmation before submitting', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ComfyWorkspacePanel jobId="job-1" checkpoints={checkpoints} capability={capability} />);

    fireEvent.click(screen.getByRole('button', { name: /Launch temporary H100 workspace/i }));

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/billable Secure Cloud H100/i));
    await waitFor(() => expect(apiClient.post).not.toHaveBeenCalled());
  });
});
