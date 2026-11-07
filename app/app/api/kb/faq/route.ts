import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireKbEditor } from '@/lib/auth';
import { asList } from '@/lib/kb';

// Курируемые FAQ-записи отдела кадров (А2/А6).
//
// Атрибуты группы (ключ, файл-источник, блок, уточняющий вопрос) хранятся в
// faq_groups; в ответе они по-прежнему лежат в каждой записи - так их ждёт UI.

export async function GET() {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const rows = await prisma.faq_entries.findMany({
    include: { group: true },
    orderBy: [{ group: { source_file: 'asc' } }, { group: { key: 'asc' } }, { position: 'asc' }],
  });

  return NextResponse.json({
    success: true,
    items: rows.map((r) => ({
      id: r.id,
      group_key: r.group.key,
      position: r.position,
      source_file: r.group.source_file,
      block: r.group.block,
      variants: asList(r.variants),
      clarify_question: r.group.clarify_question,
      option_label: r.option_label,
      answer: r.answer,
      doc_refs: asList(r.doc_refs),
      contact: r.contact,
      is_active: r.is_active,
    })),
  });
}
