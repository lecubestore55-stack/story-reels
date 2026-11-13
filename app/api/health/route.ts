import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await pool.query("SELECT 1");
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 503 });
  }
}
