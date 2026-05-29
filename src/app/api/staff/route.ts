import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { createAdminClient } = await import('@/lib/supabase/server');
  const adminClient = await createAdminClient();
  
  const { data, error } = await adminClient
    .from('staff')
    .select('*')
    .order('order_index', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ staff: data });
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile?.is_admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Use admin client to bypass RLS for these updates
  const { createAdminClient } = await import('@/lib/supabase/server');
  const adminClient = await createAdminClient();

  try {
    const { staff } = await req.json();
    if (!Array.isArray(staff)) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

    const rows = staff.map((s: any, idx: number) => ({
      name: s.name,
      role: s.role,
      description: s.description,
      image_url: s.image_url,
      order_index: idx,
      id_slug: s.id_slug || s.name.toLowerCase().replace(/\s+/g, '-')
    }));

    const { data, error } = await adminClient.from('staff').upsert(rows, { onConflict: 'id_slug' }).select();
    if (error) throw error;

    const activeSlugs = rows.map(r => r.id_slug);
    if (activeSlugs.length > 0) {
      await adminClient.from('staff').delete().not('id_slug', 'in', `(${activeSlugs.join(',')})`);
    }

    return NextResponse.json({ success: true, count: data?.length ?? 0 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
