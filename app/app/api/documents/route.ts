import { NextResponse } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { DOCUMENT_KIND_SELECT, documentTemplateKey } from '@/lib/docs/common';

// Список "Моих документов".

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const docs = await prisma.my_documents.findMany({
    // ПДн-документы не храним - в списке их нет (доступны только из сообщения
    // чата до автоудаления по TTL).
    where: { user_id: gate.user.id, is_pii: false },
    orderBy: { last_activity: 'desc' },
    select: {
      id: true,
      title: true,
      status: true,
      progress: true,
      last_activity: true,
      ...DOCUMENT_KIND_SELECT,
    },
  });

  return NextResponse.json({
    success: true,
    items: docs.map((d) => ({
      id: d.id,
      title: d.title,
      template_key: documentTemplateKey(d),
      status: d.status,
      progress: d.progress,
      last_activity: isoUtc(d.last_activity),
    })),
  });
}
