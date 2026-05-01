/**
 * Vast.ai Client Types
 */

export interface VastInstance {
  id: string;
  machine_id: number;
  actual_status: string;
  desired_status: string;
  cur_state: string;
  int_state: string;
  image_uuid: string;
  image_args: string[];
  env: Record<string, string>;
  ssh_host?: string;
  ssh_port?: number;
  ports?: Record<string, number>;
  public_ipaddr?: string;
  price_hr: number;
  disk_space: number;
  storage: number;
  cpu_cores: number;
  cpu_ram: number;
  gpu_name: string;
  gpu_ram: number;
  dlperf: number;
  inet_up: number;
  inet_down: number;
  direct_port_count: number;
  credit_discount: number;
  dph_total: number;
  dph_base: number;
  dph_machine: number;
  dph_packing: number;
  inet_up_cost: number;
  inet_down_cost: number;
  storage_cost: number;
  gpu_cost: number;
  cpu_cost: number;
  ram_cost: number;
  start_date: string;
  end_date?: string;
  duration: number;
  bunzip?: boolean;
  is_bid?: boolean;
  min_bid?: number;
  bid_per_gpu?: number;
  jupyter_token?: string;
  jupyter_port?: number;
  creation_time?: number;
  termination_time?: number;
  termination_interval?: number;
}

export interface VastOffer {
  id: number;
  machine_id: number;
  machine_name: string;
  verified: boolean;
  dph_total: number;
  dph_base: number;
  dph_packing: number;
  dph_machine: number;
  inet_up: number;
  inet_down: number;
  cpu_cores: number;
  cpu_ram: number;
  disk_space: number;
  gpu_name: string;
  gpu_ram: number;
  gpu_display_name?: string;
  reliability: number;
  dlperf: number;
  score?: number;
  num_gpus: number;
  gpu_frac: number;
  cuda_max_good: number;
  direct_port_count: number;
  direct_port_price: number;
  hosting_type?: string;
  bundled_results?: number;
  storage_cost: number;
  public_ipaddr?: string;
  geolocation?: string;
  flops_per_dphtotal: number;
  interconnect?: string;
  pcie?: string;
  pci_gen?: number;
  host_id?: number;
  host_run_time?: number;
  host_since?: number;
  start_date?: string;
  end_date?: string;
  duration?: number;
  storage_total?: number;
  storage_free?: number;
}

export interface VastTemplate {
  id: number;
  creator_id: number;
  name: string;
  image: string;
  image_tag?: string;
  dockerfile?: string;
  ssh: boolean;
  jupyter: boolean;
  direct: boolean;
  env?: Record<string, string>;
  onstart?: string;
  runtype: 'args' | 'ssh';
  use_jupyter_lab: boolean;
  jupyter_dir?: string;
  create_time: number;
  last_modified: number;
}

export interface VastEndpoint {
  id: number;
  creator_id: number;
  name: string;
  template_id: number;
  template?: VastTemplate;
  workers_min: number;
  workers_max: number;
  endpoint?: string;
  autoscale?: boolean;
  autoscale_cfg?: Record<string, unknown>;
  gpu_ids?: number[];
}

export interface VastHostReputation {
  host_id: number;
  reliability: number;
  avg_boot_time_ms?: number;
  success_count: number;
  failure_count: number;
  last_used?: number;
  notes?: string;
}

export interface VastCredentials {
  apiKey: string;
}

export type VastInstanceStatus =
  | 'running'
  | 'created'
  | 'loading'
  | 'stopping'
  | 'stopped'
  | 'terminated'
  | 'error'
  | 'queued';
