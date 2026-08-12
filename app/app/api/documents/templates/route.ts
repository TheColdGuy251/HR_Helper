import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { asList } from '@/lib/kb';

// Список шаблонов, доступных для генерации документа.
// Порт GET /api/documents/templates из backend/routes/documents.py.

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  // Порядок не задан и в Python (нет order_by) — отдаём как вернёт БД.
  const items = await prisma.doc_templates.findMany({ where: { is_enabled: true } });

  return NextResponse.json({
    success: true,
    items: items.map((t) => ({
      key: t.key,
      title: t.title,
      description: t.description,
      fields: asList(t.fields_schema),
    })),
  });
}
