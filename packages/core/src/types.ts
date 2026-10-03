export interface Pose {
  frame: string;
  xyz: [number, number, number];
  quat?: [number, number, number, number];
}

export interface Binding {
  scope_id: string;
  tag_family: string;
  tag_id: number;
  tag_size_mm: number;
  object?: string;
  bound_at?: string;
  bound_by?: string;
}

export interface SkillRef {
  ref: string;
  min_version?: string;
}

export interface ObjectDescription {
  '@context'?: string;
  id: string;
  type: string;
  name?: string;
  location?: { zone?: string; pose?: Pose };
  skills: SkillRef[];
  attributes?: Record<string, unknown>;
  bindings?: Binding[];
}

export type Sensor = 'soil_moisture' | 'light_lux' | 'temperature';

export type Condition =
  | { any: Condition[] }
  | { all: Condition[] }
  | { since_event: string; gt_days: number }
  | { measure: Sensor; lt?: number; gt?: number };

export interface Step {
  p: string;
  after_s?: number;
  [param: string]: unknown;
}

export interface Task {
  name: string;
  title_key?: string;
  trigger?: Condition;
  preconditions?: Condition[];
  season?: string[];
  steps?: Step[];
  constraints?: { max_volume_ml?: number; max_foliage_removed?: number; [k: string]: number | boolean | undefined };
  requires: string[];
  requires_human_approval?: boolean;
}

export interface SkillSignature {
  alg: 'ES256';
  kid: string;
  value: string;
}

export interface SkillManifest {
  oosr: '0.1';
  id: string;
  version: string;
  title?: string;
  applies_to: string[];
  publisher: string;
  knowledge?: string;
  integrity?: Record<string, string>;
  tasks: Task[];
  messages?: Record<string, Record<string, string>>;
  signature?: SkillSignature;
}

/** A skill package as transported over the hub API: manifest plus base64 file contents. */
export interface SkillPackage {
  manifest: SkillManifest;
  files: Record<string, string>;
}

export interface CapabilityManifest {
  oosr: '0.1';
  robot: string;
  model: string;
  primitives: string[];
  limits?: { payload_kg?: number; reach_m?: number; dispense_max_ml?: number; [k: string]: number | undefined };
}

export interface OosrEvent<D = Record<string, unknown>> {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  oosrskill?: string;
  oosrlamport: number;
  oosrsig: string;
  data: D;
}

export type UnsignedEvent<D = Record<string, unknown>> = Omit<OosrEvent<D>, 'oosrsig'>;

export interface RobotPolicy {
  write?: string[];
  zones?: string[];
}

export interface HomePolicy {
  trusted_publishers: string[];
  robots?: Record<string, RobotPolicy>;
  always_require_approval?: string[];
  quiet_hours?: { from: string; to: string };
  timezone?: string;
  hemisphere?: 'north' | 'south';
  /** Robot URN vendor segment -> manufacturer did:web that issues its device certificates. */
  trusted_manufacturers?: Record<string, string>;
  require_device_cert?: boolean;
}
