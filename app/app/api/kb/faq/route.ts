import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireKbEditor } from '@/lib/auth';
import { asList } from '@/lib/kb';

// Курируемые FAQ-записи отдела кадров (А2/А6).
// Порт GET /api/kb/faq из backend/routes/kb.py (list_faq).

export async function GET() {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const rows = await prisma.faq_entries.findMany({
    orderBy: [{ source_file: 'asc' }, { group_key: 'asc' }, { position: 'asc' }],
  });

  return NextResponse.json({
    success: true,
    items: rows.map((r) => ({
      id: r.id,
      group_key: r.group_key,
      position: r.position,
      source_file: r.source_file,
      block: r.block,
      variants: asList(r.variants),
      clarify_question: r.clarify_question,
      option_label: r.option_label,
      answer: r.answer,
      doc_refs: asList(r.doc_refs),
      contact: r.contact,
      is_active: r.is_active,
    })),
  });
}
