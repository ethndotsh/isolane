// Standard Schema (https://standardschema.dev) support: validate what guest
// code sends to host functions, what host functions return, and what an
// eval returns, with whichever schema library the application uses (Zod,
// Valibot, ArkType, ...). The interface is copied from the spec, as it
// recommends, so isolane depends on no schema library.

import { IsolaneError } from './errors.js';

/** The Standard Schema interface (v1). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  const props = (value as StandardSchemaV1 | null)?.['~standard'];
  return typeof props === 'object' && props !== null && props.version === 1 && typeof props.validate === 'function';
}

/** "path.to.field: message; other: message" */
export function describeIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>, prefix = ''): string {
  return issues
    .slice(0, 10)
    .map((issue) => {
      const path = (issue.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p));
      const where = [prefix, ...path].filter(Boolean).join('.');
      return where ? `${where}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Validate; returns the schema's output, or the issues. */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<{ ok: true; value: StandardSchemaV1.InferOutput<S> } | { ok: false; issues: ReadonlyArray<StandardSchemaV1.Issue> }> {
  const result = await schema['~standard'].validate(value);
  return result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value as StandardSchemaV1.InferOutput<S> };
}

/** An eval's result, checked against `schema`: `ERR_INVALID_RETURN` if it doesn't match. */
export async function checkReturn(schema: StandardSchemaV1, value: unknown, tenant: string): Promise<unknown> {
  const r = await validate(schema, value);
  if (r.ok) return r.value;
  throw new IsolaneError('ERR_INVALID_RETURN', `isolane: the result doesn't match its schema: ${describeIssues(r.issues)}`, {
    tenant,
    issues: r.issues,
  });
}
