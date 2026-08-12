import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';

// Категории HR-шаблонов.
// Порт GET /api/kb/template-categories из backend/routes/kb.py (list_template_categories).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const cats = await prisma.template_categories.findMany({ orderBy: { sort_order: 'asc' } });

  return NextResponse.json({
    success: true,
    items: cats.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      icon: c.icon,
      sort_order: c.sort_order,
      default_template_id: c.default_template_id,
    })),
  });
}
