import { neon } from '@neondatabase/serverless';
import { NextResponse } from 'next/server';

const sql = neon(process.env.DATABASE_URL!);
const hits = new Map<string, { n: number; reset: number }>();

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '?';
  const now = Date.now();
  const h = hits.get(ip);

  if (h && now < h.reset && h.n >= 5) {
    return NextResponse.json({}, { status: 429 });
  }

  hits.set(ip, {
    n: (h && now < h.reset ? h.n : 0) + 1,
    reset: h && now < h.reset ? h.reset : now + 900_000,
  });

  const { email } = await req.json();

  if (!email || typeof email !== 'string' || email.length > 320) {
    return NextResponse.json({}, { status: 400 });
  }

  try {
    await sql`INSERT INTO waitlist (email) VALUES (${email}) ON CONFLICT (email) DO NOTHING`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({}, { status: 500 });
  }
}
