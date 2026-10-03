import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

// ajv ships CommonJS; under NodeNext the constructor sits on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

/** Canonical schemas live at <repo>/schemas/v0; both src/ and dist/ sit two levels below. */
export const SCHEMA_DIR = fileURLToPath(new URL('../../../schemas/v0/', import.meta.url));
export const SCHEMA_BASE = 'https://oosr.dev/schema/v0/';

export type SchemaName = 'object' | 'binding' | 'skill-manifest' | 'capability' | 'event' | 'policy';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

let validators: Map<SchemaName, ValidateFunction> | undefined;

function load(): Map<SchemaName, ValidateFunction> {
  if (validators) return validators;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(SCHEMA_DIR + file, 'utf8')));
  }
  validators = new Map();
  for (const name of ['object', 'binding', 'skill-manifest', 'capability', 'event', 'policy'] as SchemaName[]) {
    const fn = ajv.getSchema(`${SCHEMA_BASE}${name}.json`);
    if (!fn) throw new Error(`schema ${name} not found in ${SCHEMA_DIR}`);
    validators.set(name, fn);
  }
  return validators;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  // if/then and oneOf produce noisy wrapper errors; keep the leaves.
  return errors
    .filter((e) => !['if', 'oneOf', 'anyOf', 'allOf'].includes(e.keyword))
    .map((e) => `${e.instancePath || '/'} ${e.message}${e.keyword === 'additionalProperties' ? ` (${String(e.params.additionalProperty)})` : ''}`);
}

export function validate(name: SchemaName, value: unknown): ValidationResult {
  const fn = load().get(name)!;
  const valid = fn(value) as boolean;
  return { valid, errors: valid ? [] : formatErrors(fn.errors) };
}
