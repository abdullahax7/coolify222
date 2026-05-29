import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { performCleanupAndLog } from '@/lib/cleanup';

// Tables that support soft-delete, with the column to display as a label
// and the timestamp column to order by.
type TableConfig = {
  table: string;
  label: string;            // friendly display name
  labelColumn: string;      // which column to show as the row's title
  fallbackColumns?: string[]; // try these if labelColumn is null
};

const TABLES: TableConfig[] = [
  { table: 'custom_properties',   label: 'Property',            labelColumn: 'title',         fallbackColumns: ['location'] },
  { table: 'orders',              label: 'Order',               labelColumn: 'name',          fallbackColumns: ['customer_name'] },
  { table: 'messages',            label: 'Message',             labelColumn: 'subject',       fallbackColumns: ['name', 'email'] },
  { table: 'cash_inquiries',      label: 'Cash Inquiry',        labelColumn: 'name',          fallbackColumns: ['address'] },
  { table: 'appointments',        label: 'Appointment',         labelColumn: 'name',          fallbackColumns: ['day'] },
  { table: 'tenancies',           label: 'Tenancy',             labelColumn: 'tenant_name',   fallbackColumns: ['property_name'] },
  { table: 'tenancy_forms',       label: 'Tenancy Form',        labelColumn: 'tenant_name',   fallbackColumns: ['property_address'] },
  { table: 'property_documents',  label: 'Property Document',   labelColumn: 'file_name',     fallbackColumns: ['document_type', 'property_name'] },
  { table: 'wales_forms',         label: 'Wales Form',          labelColumn: 'client_name',   fallbackColumns: ['form_type'] },
];

interface TrashItem {
  table: string;
  tableLabel: string;
  id: string;
  name: string;
  deleted_at: string;
  daysUntilPurge: number;     // 30 - days since deletion
}

const RETENTION_DAYS = 30;

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized', status: 401 as const };
  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile?.is_admin) return { error: 'Forbidden', status: 403 as const };
  return { user };
}

export async function GET() {
  const auth = await requireAdmin();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = await createAdminClient();
  const items: TrashItem[] = [];
  const now = Date.now();

  for (const cfg of TABLES) {
    // Select label columns + id + deleted_at. Any column missing on this
    // table is tolerated by Supabase (returns error), so we ask for known-safe
    // columns only via the config.
    const columns = ['id', 'deleted_at', cfg.labelColumn, ...(cfg.fallbackColumns ?? [])].join(',');
    const { data, error } = await admin
      .from(cfg.table)
      .select(columns)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false });

    if (error) {
      // Tolerate tables that don't exist or are missing deleted_at yet.
      if (/deleted_at/i.test(error.message) || /relation .* does not exist/i.test(error.message)) {
        continue;
      }
      console.error(`[trash] ${cfg.table}: ${error.message}`);
      continue;
    }

    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = String(row.id ?? '');
      const deletedAt = String(row.deleted_at ?? '');
      if (!id || !deletedAt) continue;
      const labelVal = row[cfg.labelColumn]
        ?? cfg.fallbackColumns?.map(c => row[c]).find(v => v != null && String(v).length > 0);
      const name = labelVal ? String(labelVal) : `(no name)`;
      const ageMs = now - new Date(deletedAt).getTime();
      const ageDays = Math.floor(ageMs / 86_400_000);
      items.push({
        table: cfg.table,
        tableLabel: cfg.label,
        id,
        name,
        deleted_at: deletedAt,
        daysUntilPurge: Math.max(0, RETENTION_DAYS - ageDays),
      });
    }
  }

  // Most recently deleted first.
  items.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { user } = auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { table, id, action } = body as { table?: string; id?: string; action?: string };
  if (!table || !id || (action !== 'restore' && action !== 'purge')) {
    return NextResponse.json({ error: 'table, id, and action (restore|purge) required' }, { status: 400 });
  }

  const cfg = TABLES.find(t => t.table === table);
  if (!cfg) return NextResponse.json({ error: `Unknown table: ${table}` }, { status: 400 });

  const admin = await createAdminClient();
  const labelCol = cfg.labelColumn;

  if (action === 'restore') {
    const { data, error } = await admin
      .from(cfg.table)
      .update({ deleted_at: null })
      .eq('id', id)
      .not('deleted_at', 'is', null)
      .select(`id,${labelCol}`);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Row not found or already restored' }, { status: 404 });
    }

    // Cascade restore to child documents so they reappear alongside the property.
    if (table === 'custom_properties') {
      const { error: docErr } = await admin
        .from('property_documents')
        .update({ deleted_at: null })
        .eq('property_id', id);
      if (docErr && !/deleted_at/i.test(docErr.message)) {
        console.warn('[trash restore] cascade documents:', docErr.message);
      }
    }

    const targetName = rows[0][labelCol] ? String(rows[0][labelCol]) : null;
    await logAudit({
      adminId: user.id, adminEmail: user.email, action: 'restore',
      targetTable: cfg.table, targetId: id, targetName, request: req,
    });
    return NextResponse.json({ ok: true });
  }

  // action === 'purge' — hard-delete.
  // For properties: clean up storage files (images + documents) before removing DB rows.
  if (table === 'custom_properties') {
    const { data: prop } = await admin
      .from('custom_properties')
      .select('id, title, image_url, gallery_urls')
      .eq('id', id)
      .single();

    if (prop) {
      const imageFiles: string[] = [];
      if (prop.image_url) imageFiles.push(prop.image_url);
      if (prop.gallery_urls) {
        const urls = String(prop.gallery_urls).split('|DELIM|').filter(Boolean);
        imageFiles.push(...urls);
      }

      // Clean up child documents from the documents bucket.
      const { data: docs } = await admin
        .from('property_documents')
        .select('id, file_url')
        .eq('property_id', id);

      const docPaths = (docs ?? [])
        .map(d => {
          const fileUrl = d.file_url as string | null;
          if (!fileUrl) return null;
          if (!fileUrl.startsWith('http')) return fileUrl;
          try {
            const url = new URL(fileUrl);
            return url.pathname.split('/documents/')[1]?.split('?')[0] ?? null;
          } catch { return null; }
        })
        .filter((p): p is string => !!p);

      if (docPaths.length > 0) {
        const { error: storageErr } = await admin.storage.from('documents').remove(docPaths);
        if (storageErr) console.warn('[trash purge] documents bucket cleanup:', storageErr.message);
      }

      // Delete child document rows.
      if (docs && docs.length > 0) {
        await admin.from('property_documents').delete().eq('property_id', id);
      }

      // Delete property images from storage and log.
      await performCleanupAndLog({
        itemId: id,
        itemType: 'property',
        itemName: prop.title,
        deletedBy: user.id,
        files: imageFiles,
      });
    }
  }

  // For property documents purged individually: clean up their file from storage.
  if (table === 'property_documents') {
    const { data: doc } = await admin
      .from('property_documents')
      .select('file_url')
      .eq('id', id)
      .single();

    if (doc?.file_url) {
      const fileUrl = doc.file_url as string;
      let path: string | null = fileUrl;
      if (fileUrl.startsWith('http')) {
        try {
          const url = new URL(fileUrl);
          path = url.pathname.split('/documents/')[1]?.split('?')[0] ?? null;
        } catch { path = null; }
      }
      if (path) {
        const { error: storageErr } = await admin.storage.from('documents').remove([path]);
        if (storageErr) console.warn('[trash purge] document file cleanup:', storageErr.message);
      }
    }
  }

  const { data, error } = await admin
    .from(cfg.table)
    .delete()
    .eq('id', id)
    .select(`id,${labelCol}`);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'Row not found' }, { status: 404 });
  }
  const targetName = rows[0][labelCol] ? String(rows[0][labelCol]) : null;
  await logAudit({
    adminId: user.id, adminEmail: user.email, action: 'delete',
    targetTable: cfg.table, targetId: id, targetName,
    diff: { hard: true, purgedFromTrash: true }, request: req,
  });
  return NextResponse.json({ ok: true });
}
