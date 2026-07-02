/**
 * Stub for the `cloudflare:workers` virtual module used in node-pool unit
 * tests. The real module is provided by the workers runtime; here we only
 * need a `WorkflowEntrypoint` base class whose constructor stashes
 * `ctx`/`env` on the instance (subclasses read `this.env`), plus the type
 * exports the workflow files import. The workflow's step orchestration is
 * driven in tests by a hand-rolled `step` mock, not by this base class.
 */
export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export type WorkflowEvent<Params = unknown> = {
  payload: Params;
  timestamp: Date;
  instanceId: string;
};

export interface WorkflowStep {
  do<T>(name: string, ...rest: unknown[]): Promise<T>;
}
