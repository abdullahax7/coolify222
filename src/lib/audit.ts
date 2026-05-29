import type { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'approve' | 'reject' | 'login' | 'logout';

// Keep the audit log bounded so the table can't grow without limit and
// overload the database. Only the newest MAX_AUDIT_ENTRIES rows are retained.
export const MAX_AUDIT_ENTRIES = 100;

interface AuditEntry {
  adminId?: string | null;
  adminEmail?: string | null;
  action: AuditAction;
  targetTable: string;
  targetId?: string | null;
  targetName?: string | null;
  diff?: Record<string, unknown> | null;
  request?: NextRequest;
}

/**
 * Best-effort audit log write. Never throws — the operation that produced
 * the audit event should never fail because telemetry failed.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const admin = await createAdminClient();
    const ip = entry.request
      ? entry.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        entry.request.headers.get('x-real-ip') ||
        null
      : null;
    const userAgent = entry.request?.headers.get('user-agent') || null;

    await admin.from('admin_audit_log').insert({
      admin_id: entry.adminId ?? null,
      admin_email: entry.adminEmail ?? null,
      action: entry.action,
      target_table: entry.targetTable,
      target_id: entry.targetId ?? null,
      target_name: entry.targetName ?? null,
      diff: entry.diff ?? null,
      ip,
      user_agent: userAgent,
    });

    // Trim old entries so the table stays bounded to the newest 100 rows.
    await trimAuditLog(admin);
  } catch (err) {
    console.error('[audit] log failed:', err);
  }
}

/**
 * Delete every audit row older than the newest MAX_AUDIT_ENTRIES.
 * Best-effort — never throws, so a failed trim can't break the write that
 * triggered it. `admin` must be a service-role client (bypasses RLS).
 */
async function trimAuditLog(admin: Awaited<ReturnType<typeof createAdminClient>>): Promise<void> {
  try {
    // Find the timestamp of the (MAX_AUDIT_ENTRIES+1)-th newest row. Anything
    // strictly older than this cutoff is surplus and can be removed.
    const { data: cutoffRows, error } = await admin
      .from('admin_audit_log')
      .select('created_at')
      .order('created_at', { ascending: false })
      .range(MAX_AUDIT_ENTRIES, MAX_AUDIT_ENTRIES);

    if (error || !cutoffRows || cutoffRows.length === 0) return; // <= limit rows, nothing to trim

    const cutoff = cutoffRows[0].created_at;
    await admin.from('admin_audit_log').delete().lt('created_at', cutoff);
  } catch (err) {
    console.error('[audit] trim failed:', err);
  }
}
