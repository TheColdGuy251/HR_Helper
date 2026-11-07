import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';

// Категории HR-шаблонов.

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const cats = await prisma.template_categories.findMany({
    orderBy: { sort_order: 'asc' },
    // Шаблон по умолчанию - флаг на самом шаблоне (не больше одного в категории).
    include: { templates: { where: { is_default: true }, select: { id: true } } },
  });

  return NextResponse.json({
    success: true,
    items: cats.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      icon: c.icon,
      sort_order: c.sort_order,
      default_template_id: c.templates[0]?.id ?? null,
    })),
  });
}
