import * as z from "zod/mini";

export type HttpMethod = "GET" | "POST" | "DELETE";

export type Endpoint<Req extends z.ZodMiniType, Res extends z.ZodMiniType> = {
  readonly method: HttpMethod;
  readonly path: string;
  readonly request: Req;
  readonly response: Res;
};

/** One gateway route: its verb, versioned path template, and request/response schemas. */
export function endpoint<Req extends z.ZodMiniType, Res extends z.ZodMiniType>(
  method: HttpMethod,
  path: `/v1/${string}`,
  request: Req,
  response: Res,
): Endpoint<Req, Res> {
  return { method, path, request, response };
}

/** Whether `value` satisfies `schema` — lets consumers validate without importing zod. */
export function accepts(schema: z.ZodMiniType, value: unknown): boolean {
  return z.safeParse(schema, value).success;
}
