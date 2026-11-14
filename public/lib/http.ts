import { NextResponse } from "next/server";
import { ensureSchema } from "./schema";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

/** Wrap a route handler: make sure the schema exists and turn thrown errors into JSON. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      await ensureSchema();
      return await fn(...args);
    } catch (e: any) {
      console.error(e);
      return fail(e?.message || "Server error", 500);
    }
  };
}

export const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
