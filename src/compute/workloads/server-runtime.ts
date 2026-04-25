export interface WorkloadServerRuntime {
  state(): Promise<any>;
  providers(): Promise<any>;
  gpuDeploy(): Promise<any>;
}

let runtime: WorkloadServerRuntime | null = null;

export function registerWorkloadServerRuntime(next: WorkloadServerRuntime): void {
  runtime = next;
}

export function getWorkloadServerRuntime(): WorkloadServerRuntime {
  if (!runtime) {
    throw new Error('Workload server runtime is not registered');
  }
  return runtime;
}
